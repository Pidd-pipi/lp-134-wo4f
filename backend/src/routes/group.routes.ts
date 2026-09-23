import { Router } from 'express';
import { z } from 'zod';
import prisma from '../config/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware.js';
import { sendInternalError, sendValidationError } from '../utils/httpResponses.js';

const router = Router();

const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1),
  topic: z.string().min(1),
  maxMembers: z.number().min(3).max(5).default(5),
  meetingTime: z.string().optional(),
  meetingFrequency: z.string().optional()
});

const createMessageSchema = z.object({
  content: z.string().min(1)
});

const createCheckInSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  reminderTime: z.string().min(1)
});

const submitCheckInSchema = z.object({
  response: z.string().max(1000).optional(),
  moodRating: z.number().min(1).max(10).optional()
});

const submitMakeupSchema = z.object({
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'),
  reason: z.string().min(1, '请填写补卡原因').max(500)
});

const reviewMakeupSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  reviewComment: z.string().max(500).optional()
});

// 按 UTC 自然日计算，保证服务端刷新后口径一致
const dateKeyOf = (date: Date): string => date.toISOString().slice(0, 10);

const utcToday = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const parseDateKey = (key: string): Date | null => {
  const date = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || dateKeyOf(date) !== key) {
    return null;
  }
  return date;
};

// 补卡窗口：错过当天后的 7 个自然日内（即 1~7 天前）
const daysBetween = (later: Date, earlier: Date): number =>
  Math.round((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000));

const checkInMemberSelect = {
  user: {
    select: {
      id: true,
      username: true,
      nickname: true,
      avatar: true
    }
  }
};

router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const groups = await prisma.supportGroup.findMany({
      where: { status: 'ACTIVE' },
      include: {
        members: {
          select: {
            user: {
              select: {
                id: true,
                username: true,
                nickname: true,
                avatar: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });

    const total = await prisma.supportGroup.count({ where: { status: 'ACTIVE' } });

    res.json({
      groups,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    sendInternalError(res, error, '获取小组列表错误', '获取小组列表失败');
  }
});

router.get('/my', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    const memberships = await prisma.groupMember.findMany({
      where: { userId },
      include: {
        group: {
          include: {
            members: {
              select: {
                user: {
                  select: {
                    id: true,
                    username: true,
                    nickname: true,
                    avatar: true
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { joinedAt: 'desc' }
    });

    const groups = memberships.map(m => m.group);

    res.json(groups);
  } catch (error) {
    sendInternalError(res, error, '获取我的小组错误', '获取我的小组失败');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const group = await prisma.supportGroup.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                nickname: true,
                avatar: true
              }
            }
          }
        },
        messages: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                nickname: true,
                avatar: true
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 50
        },
        checkInTemplates: true
      }
    });

    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    res.json(group);
  } catch (error) {
    sendInternalError(res, error, '获取小组详情错误', '获取小组详情失败');
  }
});

router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const validated = createGroupSchema.parse(req.body);
    const userId = req.user!.id;

    const group = await prisma.$transaction(async (tx) => {
      const newGroup = await tx.supportGroup.create({
        data: {
          name: validated.name,
          description: validated.description,
          topic: validated.topic,
          maxMembers: validated.maxMembers,
          meetingTime: validated.meetingTime,
          meetingFrequency: validated.meetingFrequency,
          createdBy: userId,
          status: 'ACTIVE'
        }
      });

      await tx.groupMember.create({
        data: {
          groupId: newGroup.id,
          userId,
          role: 'leader'
        }
      });

      return newGroup;
    });

    res.json({
      message: '小组创建成功',
      group
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '创建小组错误', '创建小组失败');
  }
});

router.post('/:id/join', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const group = await prisma.supportGroup.findUnique({
      where: { id }
    });

    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (existingMember) {
      return res.status(400).json({ error: '您已经是小组成员' });
    }

    const memberCount = await prisma.groupMember.count({
      where: { groupId: id }
    });

    if (memberCount >= group.maxMembers) {
      return res.status(400).json({ error: '小组已满' });
    }

    await prisma.groupMember.create({
      data: {
        groupId: id,
        userId,
        role: 'member'
      }
    });

    if (memberCount + 1 >= group.maxMembers) {
      await prisma.supportGroup.update({
        where: { id },
        data: { status: 'FULL' }
      });
    }

    res.json({ message: '加入小组成功' });
  } catch (error) {
    sendInternalError(res, error, '加入小组错误', '加入小组失败');
  }
});

router.get('/:id/messages', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const isMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!isMember) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const messages = await prisma.groupMessage.findMany({
      where: { groupId: id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatar: true
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json(messages);
  } catch (error) {
    sendInternalError(res, error, '获取小组消息错误', '获取消息失败');
  }
});

router.post('/:id/messages', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const validated = createMessageSchema.parse(req.body);
    const userId = req.user!.id;

    const isMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!isMember) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const message = await prisma.groupMessage.create({
      data: {
        groupId: id,
        userId,
        content: validated.content
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatar: true
          }
        }
      }
    });

    res.json({
      message: '消息发送成功',
      data: message
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '发送消息错误', '发送消息失败');
  }
});

router.post('/:id/checkin-templates', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const validated = createCheckInSchema.parse(req.body);
    const userId = req.user!.id;

    const isLeader = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!isLeader || isLeader.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以创建打卡' });
    }

    const template = await prisma.checkInTemplate.create({
      data: {
        groupId: id,
        title: validated.title,
        description: validated.description,
        reminderTime: validated.reminderTime
      }
    });

    res.json({
      message: '打卡模板创建成功',
      template
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '创建打卡模板错误', '创建打卡模板失败');
  }
});

// 当天打卡：每项模板每人按自然日仅一条，重复提交返回原记录且不覆盖
router.post('/checkin/:templateId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { templateId } = req.params;
    const validated = submitCheckInSchema.parse(req.body);
    const userId = req.user!.id;

    const template = await prisma.checkInTemplate.findUnique({
      where: { id: templateId },
      include: { group: true }
    });

    if (!template) {
      return res.status(404).json({ error: '打卡模板不存在' });
    }

    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: template.groupId,
          userId
        }
      }
    });

    if (!member) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const checkDate = utcToday();

    const existing = await prisma.checkIn.findUnique({
      where: {
        templateId_memberId_checkDate: {
          templateId,
          memberId: member.id,
          checkDate
        }
      }
    });

    if (existing) {
      return res.json({
        message: '今日已打卡',
        duplicated: true,
        checkIn: existing
      });
    }

    try {
      const checkIn = await prisma.checkIn.create({
        data: {
          templateId,
          memberId: member.id,
          userId,
          checkDate,
          status: 'COMPLETED',
          response: validated.response,
          moodRating: validated.moodRating
        }
      });

      return res.json({
        message: '打卡成功',
        duplicated: false,
        checkIn
      });
    } catch (createError: any) {
      // 并发提交时唯一约束兜底：返回已有记录，不覆盖
      if (createError?.code === 'P2002') {
        const concurrent = await prisma.checkIn.findUniqueOrThrow({
          where: {
            templateId_memberId_checkDate: {
              templateId,
              memberId: member.id,
              checkDate
            }
          }
        });
        return res.json({
          message: '今日已打卡',
          duplicated: true,
          checkIn: concurrent
        });
      }
      throw createError;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '打卡错误', '打卡失败');
  }
});

// 提交补卡申请：仅可申请 1~7 天前的日期；同模板同日期仅保留一条待审
router.post('/checkin/:templateId/makeup', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { templateId } = req.params;
    const validated = submitMakeupSchema.parse(req.body);
    const userId = req.user!.id;

    const template = await prisma.checkInTemplate.findUnique({
      where: { id: templateId }
    });

    if (!template) {
      return res.status(404).json({ error: '打卡模板不存在' });
    }

    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: template.groupId,
          userId
        }
      }
    });

    if (!member) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const checkDate = parseDateKey(validated.checkDate);
    if (!checkDate) {
      return res.status(400).json({ error: '补卡日期无效' });
    }

    const today = utcToday();
    const ageInDays = daysBetween(today, checkDate);
    if (ageInDays <= 0) {
      return res.status(400).json({ error: '当天打卡请直接使用今日打卡，无需补卡' });
    }
    if (ageInDays > 7) {
      return res.status(400).json({ error: '补卡仅限错过当天后的 7 天内' });
    }

    const existingCheckIn = await prisma.checkIn.findUnique({
      where: {
        templateId_memberId_checkDate: {
          templateId,
          memberId: member.id,
          checkDate
        }
      }
    });

    if (existingCheckIn) {
      return res.status(400).json({ error: '该日期已有打卡记录，无法补卡' });
    }

    const existingPending = await prisma.makeupRequest.findFirst({
      where: {
        templateId,
        memberId: member.id,
        checkDate,
        status: 'PENDING'
      }
    });

    if (existingPending) {
      return res.json({
        message: '该日期已有待审核的补卡申请',
        duplicated: true,
        makeupRequest: existingPending
      });
    }

    try {
      const makeupRequest = await prisma.makeupRequest.create({
        data: {
          templateId,
          memberId: member.id,
          userId,
          groupId: template.groupId,
          checkDate,
          reason: validated.reason,
          status: 'PENDING',
          pendingKey: `${templateId}:${member.id}:${validated.checkDate}`
        }
      });

      return res.json({
        message: '补卡申请已提交，等待组长审核',
        duplicated: false,
        makeupRequest
      });
    } catch (createError: any) {
      // 并发提交时待审唯一约束兜底：返回原待审申请
      if (createError?.code === 'P2002') {
        const concurrent = await prisma.makeupRequest.findFirstOrThrow({
          where: {
            templateId,
            memberId: member.id,
            checkDate,
            status: 'PENDING'
          }
        });
        return res.json({
          message: '该日期已有待审核的补卡申请',
          duplicated: true,
          makeupRequest: concurrent
        });
      }
      throw createError;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '提交补卡申请错误', '提交补卡申请失败');
  }
});

// 查看小组打卡记录与补卡状态：成员看本人，组长可看全部及待审申请
router.get('/:id/checkins', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const membership = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!membership) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const isLeader = membership.role === 'leader';
    const memberScope = isLeader ? {} : { memberId: membership.id };

    const [checkIns, makeupRequests] = await prisma.$transaction([
      prisma.checkIn.findMany({
        where: {
          template: { groupId: id },
          ...memberScope
        },
        include: {
          template: {
            select: { id: true, title: true, description: true, reminderTime: true }
          },
          member: {
            select: {
              id: true,
              role: true,
              ...checkInMemberSelect
            }
          }
        },
        orderBy: { checkDate: 'desc' },
        take: 500
      }),
      prisma.makeupRequest.findMany({
        where: {
          groupId: id,
          ...memberScope
        },
        include: {
          template: {
            select: { id: true, title: true }
          },
          member: {
            select: {
              id: true,
              role: true,
              ...checkInMemberSelect
            }
          },
          reviewer: {
            select: { id: true, username: true, nickname: true }
          }
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 500
      })
    ]);

    res.json({
      today: dateKeyOf(utcToday()),
      isLeader,
      checkIns,
      makeupRequests
    });
  } catch (error) {
    sendInternalError(res, error, '获取打卡记录错误', '获取打卡记录失败');
  }
});

// 组长审核补卡：同意则生成该日完成记录并保留原因；驳回则保持未完成并记录原因
router.post('/makeup/:requestId/review', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { requestId } = req.params;
    const validated = reviewMakeupSchema.parse(req.body);
    const userId = req.user!.id;

    const makeupRequest = await prisma.makeupRequest.findUnique({
      where: { id: requestId },
      include: { template: true }
    });

    if (!makeupRequest) {
      return res.status(404).json({ error: '补卡申请不存在' });
    }

    const leader = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: makeupRequest.groupId,
          userId
        }
      }
    });

    if (!leader || leader.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以审核补卡申请' });
    }

    if (makeupRequest.status !== 'PENDING') {
      return res.status(400).json({ error: '该补卡申请已审核' });
    }

    const approved = validated.action === 'APPROVE';
    const reviewedAt = new Date();

    const result = await prisma.$transaction(async (tx) => {
      let checkIn = null;

      if (approved) {
        checkIn = await tx.checkIn.upsert({
          where: {
            templateId_memberId_checkDate: {
              templateId: makeupRequest.templateId,
              memberId: makeupRequest.memberId,
              checkDate: makeupRequest.checkDate
            }
          },
          create: {
            templateId: makeupRequest.templateId,
            memberId: makeupRequest.memberId,
            userId: makeupRequest.userId,
            checkDate: makeupRequest.checkDate,
            status: 'COMPLETED',
            isMakeup: true,
            makeupReason: makeupRequest.reason
          },
          // 并发兜底：记录已存在也只保留补卡完成状态
          update: {
            status: 'COMPLETED',
            isMakeup: true,
            makeupReason: makeupRequest.reason
          }
        });
      }

      const updated = await tx.makeupRequest.update({
        where: { id: requestId },
        data: {
          status: approved ? 'APPROVED' : 'REJECTED',
          reviewerId: userId,
          reviewComment: validated.reviewComment,
          reviewedAt,
          pendingKey: null
        }
      });

      return { makeupRequest: updated, checkIn };
    });

    res.json({
      message: approved ? '补卡申请已通过' : '补卡申请已驳回',
      ...result
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '审核补卡申请错误', '审核补卡申请失败');
  }
});

export default router;
