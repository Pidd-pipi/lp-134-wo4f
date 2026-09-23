import React, { useState } from 'react';
import { groupAPI } from '../services/api';
import {
  CheckIn,
  CheckInTemplate,
  GroupMember,
  MakeUpRequest,
  User
} from '../types';

interface CheckInSectionProps {
  groupId: string;
  templates: CheckInTemplate[];
  members: GroupMember[];
  currentUser: User;
  myRole: string;
  onChanged: () => Promise<void>;
}

// 本地自然日字符串（YYYY-MM-DD），按用户浏览器时区
const toDateString = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// 接口返回的 @db.Date 可能是 "2026-09-22" 或 ISO 字符串，统一取日期部分
const normalizeDate = (value: string): string => value.slice(0, 10);

const recentDateList = (n: number): string[] => {
  const result: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    result.push(toDateString(d));
  }
  return result;
};

const formatDateLabel = (dateStr: string): string => {
  const [, month, day] = dateStr.split('-');
  return `${month}-${day}`;
};

const memberName = (user?: { username: string; nickname?: string | null }) =>
  user?.nickname || user?.username || '未知成员';

const CheckInSection: React.FC<CheckInSectionProps> = ({
  groupId,
  templates,
  members,
  currentUser,
  myRole,
  onChanged
}) => {
  const isLeader = myRole === 'leader';
  const today = toDateString(new Date());
  const last7 = recentDateList(7).filter(d => d !== today);

  const [busyId, setBusyId] = useState<string | null>(null);
  // 当天打卡备注
  const [responseByTemplate, setResponseByTemplate] = useState<Record<string, string>>({});
  // 补卡表单：templateId -> { date, reason }
  const [makeUpForm, setMakeUpForm] = useState<
    Record<string, { date: string; reason: string }>
  >({});
  // 是否展开补卡表单
  const [makeUpOpen, setMakeUpOpen] = useState<Record<string, boolean>>({});

  // 组长创建模板表单
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [newTemplate, setNewTemplate] = useState({
    title: '',
    description: '',
    reminderTime: '20:00'
  });

  const runAction = async (key: string, action: () => Promise<unknown>) => {
    setBusyId(key);
    try {
      await action();
      await onChanged();
    } catch (error: any) {
      alert(error.response?.data?.error || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleCheckIn = (templateId: string) => {
    const response = responseByTemplate[templateId]?.trim();
    return runAction(`checkin-${templateId}`, () =>
      groupAPI.submitCheckIn(templateId, response ? { response } : {})
    );
  };

  const handleApplyMakeUp = (templateId: string) => {
    const form = makeUpForm[templateId];
    if (!form?.date) {
      alert('请选择补卡日期');
      return;
    }
    if (!form.reason.trim()) {
      alert('请填写补卡原因');
      return;
    }
    return runAction(`makeup-${templateId}`, async () => {
      await groupAPI.applyMakeUp(templateId, {
        checkDate: form.date,
        reason: form.reason.trim()
      });
      setMakeUpOpen(prev => ({ ...prev, [templateId]: false }));
      setMakeUpForm(prev => ({ ...prev, [templateId]: { date: '', reason: '' } }));
    });
  };

  const handleReview = (requestId: string, action: 'approve' | 'reject') => {
    const comment = action === 'reject'
      ? window.prompt('请输入驳回原因（选填）')
      : undefined;
    if (action === 'reject' && comment === null) return; // 用户取消
    return runAction(`review-${requestId}`, () =>
      groupAPI.reviewMakeUp(requestId, {
        action,
        ...(comment ? { comment } : {})
      })
    );
  };

  const handleCreateTemplate = () => {
    if (!newTemplate.title.trim()) {
      alert('请填写打卡名称');
      return;
    }
    return runAction('create-template', async () => {
      await groupAPI.createCheckInTemplate(groupId, {
        title: newTemplate.title.trim(),
        description: newTemplate.description.trim() || undefined,
        reminderTime: newTemplate.reminderTime
      });
      setShowTemplateForm(false);
      setNewTemplate({ title: '', description: '', reminderTime: '20:00' });
    });
  };

  const myCheckInsByDate = (template: CheckInTemplate): Map<string, CheckIn> => {
    const map = new Map<string, CheckIn>();
    (template.checkIns || [])
      .filter(c => c.userId === currentUser.id)
      .forEach(c => map.set(normalizeDate(c.checkDate), c));
    return map;
  };

  const myRequestsByDate = (template: CheckInTemplate): Map<string, MakeUpRequest> => {
    const map = new Map<string, MakeUpRequest>();
    (template.makeUpRequests || [])
      .filter(r => r.userId === currentUser.id)
      .forEach(r => {
        const date = normalizeDate(r.checkDate);
        // 同一日期取最新一条（接口按创建时间倒序）
        if (!map.has(date)) map.set(date, r);
      });
    return map;
  };

  const renderDayBadge = (
    dateStr: string,
    checkIn: CheckIn | undefined,
    request: MakeUpRequest | undefined
  ) => {
    const label = formatDateLabel(dateStr);
    let content: React.ReactNode;
    let bg = 'bg-gray-100 text-gray-500';
    let title = `${dateStr}：未打卡`;

    if (checkIn) {
      if (checkIn.isMakeUp) {
        bg = 'bg-teal-100 text-teal-700';
        title = `${dateStr}：补卡完成，原因：${checkIn.makeUpReason || '无'}`;
        content = <span>{label} 补✓</span>;
      } else {
        bg = 'bg-green-100 text-green-700';
        title = `${dateStr}：已完成打卡`;
        content = <span>{label} ✓</span>;
      }
    } else if (request) {
      if (request.status === 'PENDING') {
        bg = 'bg-yellow-100 text-yellow-700';
        title = `${dateStr}：补卡待审核，原因：${request.reason}`;
        content = <span>{label} 待审</span>;
      } else if (request.status === 'REJECTED') {
        bg = 'bg-red-100 text-red-700';
        title = `${dateStr}：补卡被驳回${
          request.reviewComment ? `，原因：${request.reviewComment}` : ''
        }`;
        content = <span>{label} 驳回</span>;
      } else {
        bg = 'bg-green-100 text-green-700';
        content = <span>{label} ✓</span>;
      }
    } else {
      content = <span>{label}</span>;
    }

    return (
      <span
        key={dateStr}
        title={title}
        className={`inline-block px-2 py-1 rounded text-xs whitespace-nowrap ${bg}`}
      >
        {content}
      </span>
    );
  };

  const renderMemberCard = (template: CheckInTemplate) => {
    const myRecords = myCheckInsByDate(template);
    const myRequests = myRequestsByDate(template);
    const todayRecord = myRecords.get(today);
    const form = makeUpForm[template.id] || { date: '', reason: '' };
    const formOpen = !!makeUpOpen[template.id];

    return (
      <div className="mt-4 pt-4 border-t border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-gray-700">今日打卡</h4>
          {todayRecord ? (
            <span
              className={`text-xs px-2 py-1 rounded-full ${
                todayRecord.isMakeUp
                  ? 'bg-teal-100 text-teal-700'
                  : 'bg-green-100 text-green-700'
              }`}
            >
              {todayRecord.isMakeUp ? '今日已补卡完成' : '今日已打卡'}
            </span>
          ) : (
            <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-500">
              今日未打卡
            </span>
          )}
        </div>

        {!todayRecord && (
          <div className="space-y-2">
            <input
              type="text"
              value={responseByTemplate[template.id] || ''}
              onChange={e =>
                setResponseByTemplate(prev => ({
                  ...prev,
                  [template.id]: e.target.value
                }))
              }
              placeholder="今日感受（选填）"
              maxLength={500}
              className="input-field text-sm"
            />
            <button
              onClick={() => handleCheckIn(template.id)}
              disabled={busyId === `checkin-${template.id}`}
              className="btn-primary w-full text-sm disabled:opacity-50"
            >
              {busyId === `checkin-${template.id}` ? '提交中...' : '完成今日打卡'}
            </button>
          </div>
        )}

        {todayRecord?.isMakeUp && todayRecord.makeUpReason && (
          <p className="text-xs text-teal-700 bg-teal-50 rounded p-2 mb-2">
            补卡原因：{todayRecord.makeUpReason}
          </p>
        )}

        {/* 近 7 天记录与补卡状态 */}
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-2">近 7 天记录</p>
          <div className="flex flex-wrap gap-1.5">
            {last7.map(dateStr =>
              renderDayBadge(dateStr, myRecords.get(dateStr), myRequests.get(dateStr))
            )}
          </div>
        </div>

        {/* 补卡申请 */}
        <div className="mt-3">
          {!formOpen ? (
            <button
              onClick={() =>
                setMakeUpOpen(prev => ({ ...prev, [template.id]: true }))
              }
              className="text-xs text-primary-600 hover:underline"
            >
              申请补卡（最近 7 天）
            </button>
          ) : (
            <div className="space-y-2 bg-gray-50 rounded p-3">
              <div>
                <label className="text-xs text-gray-500">补卡日期</label>
                <select
                  value={form.date}
                  onChange={e =>
                    setMakeUpForm(prev => ({
                      ...prev,
                      [template.id]: { ...form, date: e.target.value }
                    }))
                  }
                  className="input-field text-sm mt-1"
                >
                  <option value="">请选择日期</option>
                  {last7
                    .slice()
                    .reverse()
                    .map(dateStr => {
                      const record = myRecords.get(dateStr);
                      const pending = myRequests.get(dateStr)?.status === 'PENDING';
                      let disabledReason = '';
                      if (record) disabledReason = '已完成打卡';
                      else if (pending) disabledReason = '已有待审申请';
                      return (
                        <option
                          key={dateStr}
                          value={dateStr}
                          disabled={!!disabledReason}
                        >
                          {dateStr}
                          {disabledReason ? `（${disabledReason}）` : ''}
                        </option>
                      );
                    })}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">补卡原因</label>
                <textarea
                  value={form.reason}
                  onChange={e =>
                    setMakeUpForm(prev => ({
                      ...prev,
                      [template.id]: { ...form, reason: e.target.value }
                    }))
                  }
                  placeholder="请说明错过打卡的原因"
                  maxLength={200}
                  rows={2}
                  className="input-field text-sm mt-1"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleApplyMakeUp(template.id)}
                  disabled={busyId === `makeup-${template.id}`}
                  className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50"
                >
                  {busyId === `makeup-${template.id}` ? '提交中...' : '提交申请'}
                </button>
                <button
                  onClick={() =>
                    setMakeUpOpen(prev => ({ ...prev, [template.id]: false }))
                  }
                  className="text-xs px-3 py-1.5 text-gray-500 hover:underline"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 被驳回的申请展示驳回原因（仍可重新申请） */}
        {last7.map(dateStr => {
          const req = myRequests.get(dateStr);
          if (!req || req.status !== 'REJECTED') return null;
          return (
            <p key={req.id} className="text-xs text-red-600 mt-2">
              {dateStr} 补卡被驳回
              {req.reviewComment ? `：${req.reviewComment}` : '，可修改原因后重新申请'}
            </p>
          );
        })}
      </div>
    );
  };

  const renderLeaderReview = (template: CheckInTemplate) => {
    const pending = (template.makeUpRequests || []).filter(r => r.status === 'PENDING');
    if (!isLeader) return null;

    return (
      <div className="mt-4 pt-4 border-t border-gray-100">
        <h4 className="text-sm font-semibold text-gray-700 mb-2">
          待审补卡
          <span className="ml-2 text-xs font-normal bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
            {pending.length}
          </span>
        </h4>
        {pending.length === 0 ? (
          <p className="text-xs text-gray-400">暂无待审核的补卡申请</p>
        ) : (
          <div className="space-y-2">
            {pending.map(req => (
              <div
                key={req.id}
                className="flex items-start justify-between gap-2 bg-yellow-50 rounded p-2"
              >
                <div className="text-xs min-w-0">
                  <p className="font-medium text-gray-700">
                    {memberName(req.user)} · {normalizeDate(req.checkDate)}
                  </p>
                  <p className="text-gray-600 mt-0.5 break-all">原因：{req.reason}</p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleReview(req.id, 'approve')}
                    disabled={busyId === `review-${req.id}`}
                    className="text-xs px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
                  >
                    同意
                  </button>
                  <button
                    onClick={() => handleReview(req.id, 'reject')}
                    disabled={busyId === `review-${req.id}`}
                    className="text-xs px-2 py-1 bg-red-400 text-white rounded hover:bg-red-500 disabled:opacity-50"
                  >
                    驳回
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderOverview = (template: CheckInTemplate) => {
    if (!isLeader) return null;
    const dates = recentDateList(7);

    return (
      <div className="mt-4 pt-4 border-t border-gray-100">
        <h4 className="text-sm font-semibold text-gray-700 mb-2">成员近 7 天打卡</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400">
                <th className="text-left font-normal py-1 pr-2">成员</th>
                {dates.map(d => (
                  <th key={d} className="font-normal px-1 py-1">
                    {formatDateLabel(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map(member => {
                const records = new Map(
                  (template.checkIns || [])
                    .filter(c => c.userId === member.userId)
                    .map(c => [normalizeDate(c.checkDate), c])
                );
                const requests = new Map(
                  (template.makeUpRequests || [])
                    .filter(r => r.userId === member.userId && r.status === 'PENDING')
                    .map(r => [normalizeDate(r.checkDate), r])
                );
                return (
                  <tr key={member.id} className="border-t border-gray-50">
                    <td className="py-1 pr-2 text-gray-700 whitespace-nowrap">
                      {memberName(member.user)}
                    </td>
                    {dates.map(d => {
                      const c = records.get(d);
                      const pending = requests.has(d);
                      let mark = '—';
                      let cls = 'text-gray-300';
                      if (c?.isMakeUp) {
                        mark = '补✓';
                        cls = 'text-teal-600';
                      } else if (c) {
                        mark = '✓';
                        cls = 'text-green-600';
                      } else if (pending) {
                        mark = '待审';
                        cls = 'text-yellow-600';
                      } else if (d !== today) {
                        mark = '缺';
                        cls = 'text-red-400';
                      }
                      return (
                        <td key={d} className={`px-1 py-1 text-center ${cls}`}>
                          {mark}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">每日打卡</h2>
        {isLeader && (
          <button
            onClick={() => setShowTemplateForm(prev => !prev)}
            className="text-sm text-primary-600 hover:underline"
          >
            {showTemplateForm ? '取消创建' : '+ 新建打卡'}
          </button>
        )}
      </div>

      {isLeader && showTemplateForm && (
        <div className="space-y-2 bg-gray-50 rounded p-3 mb-4">
          <input
            type="text"
            value={newTemplate.title}
            onChange={e => setNewTemplate(prev => ({ ...prev, title: e.target.value }))}
            placeholder="打卡名称，如：每日心情打卡"
            className="input-field text-sm"
          />
          <input
            type="text"
            value={newTemplate.description}
            onChange={e =>
              setNewTemplate(prev => ({ ...prev, description: e.target.value }))
            }
            placeholder="打卡说明（选填）"
            className="input-field text-sm"
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">提醒时间</label>
            <input
              type="time"
              value={newTemplate.reminderTime}
              onChange={e =>
                setNewTemplate(prev => ({ ...prev, reminderTime: e.target.value }))
              }
              className="input-field text-sm flex-1"
            />
          </div>
          <button
            onClick={handleCreateTemplate}
            disabled={busyId === 'create-template'}
            className="btn-primary text-sm w-full disabled:opacity-50"
          >
            {busyId === 'create-template' ? '创建中...' : '创建打卡'}
          </button>
        </div>
      )}

      {templates.length === 0 ? (
        <p className="text-sm text-gray-500">
          {isLeader ? '还没有打卡项目，点击右上角「新建打卡」开始吧。' : '组长暂未创建打卡项目。'}
        </p>
      ) : (
        <div className="space-y-4">
          {templates.map(template => (
            <div key={template.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-800">{template.title}</h3>
                  {template.description && (
                    <p className="text-xs text-gray-500 mt-0.5">{template.description}</p>
                  )}
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
                  ⏰ {template.reminderTime}
                </span>
              </div>

              {renderMemberCard(template)}
              {renderLeaderReview(template)}
              {renderOverview(template)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CheckInSection;
