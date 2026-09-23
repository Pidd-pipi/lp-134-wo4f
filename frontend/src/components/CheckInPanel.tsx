import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { groupAPI } from '../services/api';
import {
  CheckIn,
  CheckInTemplate,
  GroupCheckInsResponse,
  MakeupRequest,
  SupportGroup
} from '../types';
import { useAuth } from '../context/AuthContext';

const dayKeyOf = (iso: string): string => iso.slice(0, 10);

interface CheckInPanelProps {
  group: SupportGroup;
  isMember: boolean;
  onGroupChanged: () => Promise<void>;
}

const statusBadge = (status: MakeupRequest['status']) => {
  if (status === 'PENDING') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-700">待审核</span>;
  }
  if (status === 'APPROVED') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">已通过</span>;
  }
  return <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700">已驳回</span>;
};

const CheckInPanel: React.FC<CheckInPanelProps> = ({ group, isMember, onGroupChanged }) => {
  const { user } = useAuth();
  const [data, setData] = useState<GroupCheckInsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [newTemplate, setNewTemplate] = useState({ title: '', description: '', reminderTime: '20:00' });
  const [makeupTarget, setMakeupTarget] = useState<CheckInTemplate | null>(null);
  const [makeupDate, setMakeupDate] = useState('');
  const [makeupReason, setMakeupReason] = useState('');
  const [makeupSubmitting, setMakeupSubmitting] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewComments, setReviewComments] = useState<Record<string, string>>({});
  // checkins 折叠状态：templateId -> 是否展开
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isLeader = useMemo(
    () => !!group.members?.some(m => m.userId === user?.id && m.role === 'leader'),
    [group.members, user]
  );

  const fetchCheckIns = useCallback(async () => {
    if (!isMember || !user) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const response = await groupAPI.getCheckIns(group.id);
      setData(response.data);
    } catch (error: any) {
      console.error('获取打卡记录失败:', error);
    } finally {
      setLoading(false);
    }
  }, [group.id, isMember, user]);

  useEffect(() => {
    fetchCheckIns();
  }, [fetchCheckIns]);

  const myCheckMap = useMemo(() => {
    const map = new Map<string, CheckIn>();
    data?.checkIns
      .filter(c => c.userId === user?.id)
      .forEach(c => map.set(`${c.templateId}|${dayKeyOf(c.checkDate)}`, c));
    return map;
  }, [data, user]);

  const myMakeupMap = useMemo(() => {
    const map = new Map<string, MakeupRequest>();
    data?.makeupRequests
      .filter(r => r.userId === user?.id)
      .forEach(r => {
        // 待审优先，其次最新
        const key = `${r.templateId}|${dayKeyOf(r.checkDate)}`;
        const existing = map.get(key);
        if (!existing || (existing.status !== 'PENDING' && r.status === 'PENDING')) {
          map.set(key, r);
        }
      });
    return map;
  }, [data, user]);

  const pendingReviews = useMemo(
    () => data?.makeupRequests.filter(r => r.status === 'PENDING') ?? [],
    [data]
  );

  // 过去 1~7 天的日期选项（以服务端返回的自然日为准）
  const makeupDateOptions = useMemo(() => {
    if (!data?.today) return [];
    const today = new Date(`${data.today}T00:00:00.000Z`);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - (i + 1));
      return dayKeyOf(d.toISOString());
    });
  }, [data?.today]);

  const handleCheckIn = async (template: CheckInTemplate) => {
    setBusyTemplateId(template.id);
    try {
      const response = await groupAPI.submitCheckIn(template.id, {});
      await fetchCheckIns();
      alert(response.data?.duplicated ? '今日已打卡，无需重复打卡' : '打卡成功！');
    } catch (error: any) {
      alert(error.response?.data?.error || '打卡失败');
    } finally {
      setBusyTemplateId(null);
    }
  };

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await groupAPI.createCheckInTemplate(group.id, newTemplate);
      setShowCreateTemplate(false);
      setNewTemplate({ title: '', description: '', reminderTime: '20:00' });
      await onGroupChanged();
    } catch (error: any) {
      alert(error.response?.data?.error || '创建打卡失败');
    }
  };

  const openMakeup = (template: CheckInTemplate) => {
    setMakeupTarget(template);
    const firstAvailable = makeupDateOptions.find(
      date =>
        !myCheckMap.has(`${template.id}|${date}`) &&
        myMakeupMap.get(`${template.id}|${date}`)?.status !== 'PENDING'
    );
    setMakeupDate(firstAvailable ?? makeupDateOptions[0] ?? '');
    setMakeupReason('');
  };

  const handleSubmitMakeup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!makeupTarget) return;
    setMakeupSubmitting(true);
    try {
      const response = await groupAPI.submitMakeup(makeupTarget.id, {
        checkDate: makeupDate,
        reason: makeupReason
      });
      await fetchCheckIns();
      setMakeupTarget(null);
      alert(response.data?.duplicated ? '该日期已有待审核的补卡申请' : '补卡申请已提交，等待组长审核');
    } catch (error: any) {
      alert(error.response?.data?.error || '提交补卡申请失败');
    } finally {
      setMakeupSubmitting(false);
    }
  };

  const handleReview = async (request: MakeupRequest, action: 'APPROVE' | 'REJECT') => {
    const comment = (reviewComments[request.id] ?? '').trim();
    if (action === 'REJECT' && !comment) {
      alert('请填写驳回原因');
      return;
    }
    setReviewingId(request.id);
    try {
      await groupAPI.reviewMakeup(request.id, {
        action,
        reviewComment: comment || undefined
      });
      setReviewComments(prev => {
        const next = { ...prev };
        delete next[request.id];
        return next;
      });
      await fetchCheckIns();
    } catch (error: any) {
      alert(error.response?.data?.error || '审核失败');
    } finally {
      setReviewingId(null);
    }
  };

  if (!isMember || !user) return null;

  const templates = group.checkInTemplates ?? [];
  const myRecords = data?.checkIns.filter(c => c.userId === user.id) ?? [];
  const myRequests = data?.makeupRequests.filter(r => r.userId === user.id) ?? [];

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">每日打卡</h2>
        {isLeader && (
          <button
            onClick={() => setShowCreateTemplate(v => !v)}
            className="text-sm text-primary-600 hover:underline"
          >
            {showCreateTemplate ? '取消' : '+ 新建打卡项'}
          </button>
        )}
      </div>

      {isLeader && showCreateTemplate && (
        <form onSubmit={handleCreateTemplate} className="bg-gray-50 rounded-lg p-4 mb-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <input
              type="text"
              value={newTemplate.title}
              onChange={e => setNewTemplate({ ...newTemplate, title: e.target.value })}
              className="input-field"
              placeholder="打卡项名称，如：情绪记录"
              required
            />
            <input
              type="time"
              value={newTemplate.reminderTime}
              onChange={e => setNewTemplate({ ...newTemplate, reminderTime: e.target.value })}
              className="input-field"
              required
            />
          </div>
          <input
            type="text"
            value={newTemplate.description}
            onChange={e => setNewTemplate({ ...newTemplate, description: e.target.value })}
            className="input-field"
            placeholder="打卡说明（可选）"
          />
          <div className="text-right">
            <button type="submit" className="btn-primary text-sm">创建</button>
          </div>
        </form>
      )}

      {templates.length === 0 ? (
        <p className="text-gray-500 text-sm py-4 text-center">
          {isLeader ? '还没有打卡项，点击右上角「新建打卡项」' : '组长还未创建打卡项'}
        </p>
      ) : (
        <div className="space-y-4">
          {templates.map(template => {
            const todayKey = data?.today ?? '';
            const todayRecord = myCheckMap.get(`${template.id}|${todayKey}`);
            const pendingForTemplate = [...myMakeupMap.values()].filter(
              r => r.templateId === template.id && r.status === 'PENDING'
            );

            return (
              <div key={template.id} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="font-semibold text-gray-800">{template.title}</p>
                    {template.description && (
                      <p className="text-sm text-gray-500 mt-1">{template.description}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-1">提醒时间：{template.reminderTime}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {todayRecord ? (
                      <span className="px-3 py-1.5 rounded-full text-sm bg-green-100 text-green-700">
                        ✓ 今日已完成
                      </span>
                    ) : (
                      <button
                        onClick={() => handleCheckIn(template)}
                        disabled={busyTemplateId === template.id}
                        className="btn-primary text-sm disabled:opacity-50"
                      >
                        {busyTemplateId === template.id ? '提交中...' : '今日打卡'}
                      </button>
                    )}
                    <button
                      onClick={() => openMakeup(template)}
                      className="px-3 py-1.5 text-sm rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50"
                    >
                      补卡申请
                    </button>
                  </div>
                </div>

                {pendingForTemplate.length > 0 && (
                  <div className="mt-3 text-sm text-yellow-700 bg-yellow-50 rounded px-3 py-2">
                    {pendingForTemplate.map(r => (
                      <span key={r.id} className="inline-flex items-center gap-2 mr-4">
                        {statusBadge('PENDING')}
                        补卡日期 {dayKeyOf(r.checkDate)}：{r.reason}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 组长审核区 */}
      {isLeader && pendingReviews.length > 0 && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-3">
            补卡审核（{pendingReviews.length}）
          </h3>
          <div className="space-y-3">
            {pendingReviews.map(request => (
              <div key={request.id} className="border border-yellow-200 rounded-lg p-4 bg-yellow-50/50">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-sm">
                    <span className="font-medium text-gray-800">
                      {request.member?.user.nickname || request.member?.user.username}
                    </span>
                    <span className="text-gray-500 mx-2">·</span>
                    <span className="text-gray-700">{request.template?.title}</span>
                    <span className="text-gray-500 mx-2">·</span>
                    <span className="text-gray-700">{dayKeyOf(request.checkDate)}</span>
                    <span className="ml-2">{statusBadge(request.status)}</span>
                  </div>
                </div>
                <p className="text-sm text-gray-600 mt-2">补卡原因：{request.reason}</p>
                <div className="mt-3 flex gap-2 items-start">
                  <input
                    type="text"
                    value={reviewComments[request.id] ?? ''}
                    onChange={e => setReviewComments(prev => ({ ...prev, [request.id]: e.target.value }))}
                    className="input-field flex-1 text-sm"
                    placeholder="审核备注（驳回时必填）"
                  />
                  <button
                    onClick={() => handleReview(request, 'APPROVE')}
                    disabled={reviewingId === request.id}
                    className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 whitespace-nowrap disabled:opacity-50"
                  >
                    同意
                  </button>
                  <button
                    onClick={() => handleReview(request, 'REJECT')}
                    disabled={reviewingId === request.id}
                    className="px-4 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 whitespace-nowrap disabled:opacity-50"
                  >
                    驳回
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 记录与申请状态 */}
      <div className="mt-6 grid md:grid-cols-2 gap-6">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-800">我的打卡记录</h3>
            <button
              onClick={() => setExpanded(e => ({ ...e, records: !e.records }))}
              className="text-xs text-primary-600 hover:underline"
            >
              {expanded.records ? '收起' : '查看全部'}
            </button>
          </div>
          {myRecords.length === 0 ? (
            <p className="text-sm text-gray-400">暂无打卡记录</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(expanded.records ? myRecords : myRecords.slice(0, 5)).map(record => (
                <li key={record.id} className="flex items-center justify-between gap-2 border-b border-gray-100 pb-2">
                  <div>
                    <span className="text-gray-700">{dayKeyOf(record.checkDate)}</span>
                    <span className="text-gray-400 mx-2">·</span>
                    <span className="text-gray-600">{record.template?.title}</span>
                    {record.isMakeup && (
                      <span className="ml-2 px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-700">补卡</span>
                    )}
                  </div>
                  <span className="text-green-600">已完成</span>
                </li>
              ))}
            </ul>
          )}
          {myRecords.some(r => r.isMakeup && r.makeupReason) && (
            <div className="mt-2 space-y-1">
              {myRecords
                .filter(r => r.isMakeup && r.makeupReason)
                .slice(0, expanded.records ? undefined : 2)
                .map(r => (
                  <p key={`reason-${r.id}`} className="text-xs text-gray-500">
                    {dayKeyOf(r.checkDate)} {r.template?.title} 补卡原因：{r.makeupReason}
                  </p>
                ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-800">我的补卡申请</h3>
            <button
              onClick={() => setExpanded(e => ({ ...e, requests: !e.requests }))}
              className="text-xs text-primary-600 hover:underline"
            >
              {expanded.requests ? '收起' : '查看全部'}
            </button>
          </div>
          {myRequests.length === 0 ? (
            <p className="text-sm text-gray-400">暂无补卡申请</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(expanded.requests ? myRequests : myRequests.slice(0, 5)).map(request => (
                <li key={request.id} className="border-b border-gray-100 pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-gray-700">{dayKeyOf(request.checkDate)}</span>
                      <span className="text-gray-400 mx-2">·</span>
                      <span className="text-gray-600">{request.template?.title}</span>
                    </div>
                    {statusBadge(request.status)}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">原因：{request.reason}</p>
                  {request.status === 'REJECTED' && (
                    <p className="text-xs text-red-500 mt-1">
                      该日保持未完成{request.reviewComment ? `，审核备注：${request.reviewComment}` : ''}
                    </p>
                  )}
                  {request.status === 'APPROVED' && (
                    <p className="text-xs text-green-600 mt-1">该日已记为完成</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 组长可见的全部记录 */}
      {isLeader && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-800">全部成员打卡记录</h3>
            <button
              onClick={() => setExpanded(e => ({ ...e, all: !e.all }))}
              className="text-xs text-primary-600 hover:underline"
            >
              {expanded.all ? '收起' : '查看全部'}
            </button>
          </div>
          <ul className="space-y-2 text-sm">
            {(data?.checkIns ?? []).slice(0, expanded.all ? undefined : 5).map(record => (
              <li key={record.id} className="flex items-center justify-between gap-2 border-b border-gray-100 pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-gray-700">
                    {record.member?.user.nickname || record.member?.user.username}
                  </span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600">{dayKeyOf(record.checkDate)} {record.template?.title}</span>
                  {record.isMakeup && (
                    <span className="px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-700">补卡</span>
                  )}
                </div>
                <span className="text-green-600 whitespace-nowrap">已完成</span>
              </li>
            ))}
            {(data?.checkIns.length ?? 0) === 0 && <p className="text-sm text-gray-400">暂无记录</p>}
          </ul>
        </div>
      )}

      {loading && <p className="text-xs text-gray-400 text-center mt-3">刷新中...</p>}

      {/* 补卡申请弹窗 */}
      {makeupTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold text-gray-800 mb-1">补卡申请 · {makeupTarget.title}</h3>
            <p className="text-xs text-gray-500 mb-4">仅可申请过去 7 天内（不含当天）的打卡</p>
            <form onSubmit={handleSubmitMakeup} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">补卡日期</label>
                <select
                  value={makeupDate}
                  onChange={e => setMakeupDate(e.target.value)}
                  className="input-field"
                  required
                >
                  {makeupDateOptions.map(date => {
                    const record = myCheckMap.get(`${makeupTarget.id}|${date}`);
                    const request = myMakeupMap.get(`${makeupTarget.id}|${date}`);
                    const disabled = !!record || request?.status === 'PENDING';
                    return (
                      <option key={date} value={date} disabled={disabled}>
                        {date}
                        {record ? '（已完成）' : request?.status === 'PENDING' ? '（审核中）' : ''}
                      </option>
                    );
                  })}
                </select>
                {makeupDate && myMakeupMap.get(`${makeupTarget.id}|${makeupDate}`)?.status === 'REJECTED' && (
                  <p className="text-xs text-red-500 mt-1">
                    该日期之前的申请已被驳回，可修改原因后重新提交。
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">补卡原因 *</label>
                <textarea
                  value={makeupReason}
                  onChange={e => setMakeupReason(e.target.value)}
                  className="input-field min-h-[90px]"
                  placeholder="请说明错过当天打卡的原因..."
                  required
                  maxLength={500}
                />
              </div>
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setMakeupTarget(null)} className="btn-secondary">
                  取消
                </button>
                <button type="submit" disabled={makeupSubmitting} className="btn-primary disabled:opacity-50">
                  {makeupSubmitting ? '提交中...' : '提交申请'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CheckInPanel;
