import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware.js';
import { sendInternalError, sendValidationError } from '../utils/httpResponses.js';
import {
  dateStringToUtcNoon,
  diffDays,
  isValidDateString,
  todayInShanghai
} from '../utils/date.js';

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
  response: z.string().max(500).optional(),
  moodRating: z.number().min(1).max(10).optional()
});

const applyMakeUpSchema = z.object({
  checkDate: z.string().refine(isValidDateString, '日期格式应为 YYYY-MM-DD'),
  reason: z.string().min(1, '请填写补卡原因').max(200, '补卡原因不能超过200字')
});

const reviewMakeUpSchema = z.object({
  action: z.enum(['approve', 'reject']),
  comment: z.string().max(200).optional()
});

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

    const today = todayInShanghai();
    const sixtyDaysAgo = (() => {
      const [year, month, day] = today.split('-').map(Number);
      const d = new Date(Date.UTC(year, month - 1, day, 12));
      d.setUTCDate(d.getUTCDate() - 59);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate()
      ).padStart(2, '0')}`;
    })();

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
        checkInTemplates: {
          include: {
            checkIns: {
              where: { checkDate: { gte: dateStringToUtcNoon(sixtyDaysAgo) } },
              orderBy: { checkDate: 'desc' }
            },
            makeUpRequests: {
              where: { createdAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } },
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
              orderBy: { createdAt: 'desc' }
            }
          }
        }
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

// 当天打卡：每个模板每人按自然日只有一条记录，重复提交返回原记录且不覆盖
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

    const today = todayInShanghai();
    const checkDate = dateStringToUtcNoon(today);

    const existingCheckIn = await prisma.checkIn.findUnique({
      where: {
        templateId_memberId_checkDate: {
          templateId,
          memberId: member.id,
          checkDate
        }
      }
    });

    // 重复提交：返回原记录，不能覆盖
    if (existingCheckIn) {
      return res.json({
        message: existingCheckIn.isMakeUp ? '今日已通过补卡完成打卡' : '今日已打卡',
        duplicated: true,
        checkIn: existingCheckIn
      });
    }

    const checkIn = await prisma.checkIn.create({
      data: {
        templateId,
        memberId: member.id,
        userId,
        checkDate,
        status: 'COMPLETED',
        response: validated.response,
        moodRating: validated.moodRating,
        isMakeUp: false
      }
    });

    res.json({
      message: '打卡成功',
      duplicated: false,
      checkIn
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '打卡错误', '打卡失败');
  }
});

// 补卡申请：错过当天后 7 天内可提交带原因的申请；同模板同日期只保留一条待审申请
router.post(
  '/checkin/:templateId/makeup',
  authMiddleware,
  async (req: AuthRequest, res) => {
    try {
      const { templateId } = req.params;
      const validated = applyMakeUpSchema.parse(req.body);
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

      const today = todayInShanghai();
      const targetDate = validated.checkDate;
      const dayOffset = diffDays(today, targetDate);

      if (dayOffset >= 0) {
        return res
          .status(400)
          .json({ error: dayOffset === 0 ? '当天打卡尚未截止，请直接打卡' : '补卡日期不能晚于今天' });
      }
      if (dayOffset < -7) {
        return res.status(400).json({ error: '只能补卡最近 7 天内（含第 7 天）的记录' });
      }

      // 当天已完成打卡（含已批准的补卡），不能重复申请
      const existingCheckIn = await prisma.checkIn.findUnique({
        where: {
          templateId_memberId_checkDate: {
            templateId,
            memberId: member.id,
            checkDate: dateStringToUtcNoon(targetDate)
          }
        }
      });

      if (existingCheckIn) {
        return res.status(400).json({ error: '该日期已完成打卡，无需补卡' });
      }

      // 已有待审申请：返回原申请，不重复创建
      const pendingRequest = await prisma.makeUpRequest.findFirst({
        where: {
          templateId,
          memberId: member.id,
          checkDate: dateStringToUtcNoon(targetDate),
          status: 'PENDING'
        }
      });

      if (pendingRequest) {
        return res.json({
          message: '该日期已有待审核的补卡申请',
          duplicated: true,
          makeUpRequest: pendingRequest
        });
      }

      try {
        const makeUpRequest = await prisma.makeUpRequest.create({
          data: {
            templateId,
            memberId: member.id,
            userId,
            checkDate: dateStringToUtcNoon(targetDate),
            reason: validated.reason,
            status: 'PENDING'
          }
        });

        return res.json({
          message: '补卡申请已提交，等待组长审核',
          duplicated: false,
          makeUpRequest
        });
      } catch (createError) {
        // 并发情况下命中部分唯一索引（同模板同成员同日仅一条待审）
        if (
          createError instanceof Prisma.PrismaClientKnownRequestError &&
          createError.code === 'P2002'
        ) {
          const racingRequest = await prisma.makeUpRequest.findFirst({
            where: {
              templateId,
              memberId: member.id,
              checkDate: dateStringToUtcNoon(targetDate),
              status: 'PENDING'
            }
          });
          return res.json({
            message: '该日期已有待审核的补卡申请',
            duplicated: true,
            makeUpRequest: racingRequest
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
  }
);

// 组长审核补卡：同意后该日记录显示完成并保留补卡原因；驳回保留未完成并展示原因
router.post(
  '/makeup/:requestId/review',
  authMiddleware,
  async (req: AuthRequest, res) => {
    try {
      const { requestId } = req.params;
      const validated = reviewMakeUpSchema.parse(req.body);
      const userId = req.user!.id;

      const makeUpRequest = await prisma.makeUpRequest.findUnique({
        where: { id: requestId },
        include: { template: true }
      });

      if (!makeUpRequest) {
        return res.status(404).json({ error: '补卡申请不存在' });
      }

      const leader = await prisma.groupMember.findUnique({
        where: {
          groupId_userId: {
            groupId: makeUpRequest.template.groupId,
            userId
          }
        }
      });

      if (!leader || leader.role !== 'leader') {
        return res.status(403).json({ error: '只有组长可以审核补卡申请' });
      }

      if (makeUpRequest.status !== 'PENDING') {
        return res.status(400).json({ error: '该补卡申请已审核' });
      }

      if (validated.action === 'approve') {
        const result = await prisma.$transaction(async (tx) => {
          const checkIn = await tx.checkIn.upsert({
            where: {
              templateId_memberId_checkDate: {
                templateId: makeUpRequest.templateId,
                memberId: makeUpRequest.memberId,
                checkDate: makeUpRequest.checkDate
              }
            },
            update: {
              status: 'COMPLETED',
              isMakeUp: true,
              makeUpReason: makeUpRequest.reason
            },
            create: {
              templateId: makeUpRequest.templateId,
              memberId: makeUpRequest.memberId,
              userId: makeUpRequest.userId,
              checkDate: makeUpRequest.checkDate,
              status: 'COMPLETED',
              isMakeUp: true,
              makeUpReason: makeUpRequest.reason
            }
          });

          const reviewed = await tx.makeUpRequest.update({
            where: { id: requestId },
            data: {
              status: 'APPROVED',
              reviewComment: validated.comment || null,
              reviewedBy: userId,
              reviewedAt: new Date()
            }
          });

          return { checkIn, makeUpRequest: reviewed };
        });

        return res.json({ message: '已同意补卡申请', ...result });
      }

      const reviewed = await prisma.makeUpRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          reviewComment: validated.comment || null,
          reviewedBy: userId,
          reviewedAt: new Date()
        }
      });

      res.json({ message: '已驳回补卡申请', makeUpRequest: reviewed });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return sendValidationError(res, error);
      }
      sendInternalError(res, error, '审核补卡申请错误', '审核补卡申请失败');
    }
  }
);

export default router;
