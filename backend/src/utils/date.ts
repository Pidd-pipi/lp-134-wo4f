// 按自然日（Asia/Shanghai）计算打卡日期，避免 UTC 时区导致跨天问题。

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 返回上海时区当天的日期字符串，格式 YYYY-MM-DD */
export const todayInShanghai = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const map = new Map(parts.map(p => [p.type, p.value]));
  return `${map.get('year')}-${map.get('month')}-${map.get('day')}`;
};

/** 校验 YYYY-MM-DD 格式且为真实日期 */
export const isValidDateString = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

/** 将 YYYY-MM-DD 转为以 UTC 正午存储的 Date，避免 @db.Date 落库时发生时区偏移 */
export const dateStringToUtcNoon = (value: string): Date => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
};

/** 两个 YYYY-MM-DD 日期相差的天数（b - a），按字典序即可正确计算 */
export const diffDays = (a: string, b: string): number => {
  const ms = dateStringToUtcNoon(b).getTime() - dateStringToUtcNoon(a).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
};

/** 最近 n 天的日期字符串数组（含今天，按日期升序） */
export const recentDates = (n: number, now: Date = new Date()): string[] => {
  const today = dateStringToUtcNoon(todayInShanghai(now));
  const result: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    result.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate()
      ).padStart(2, '0')}`
    );
  }
  return result;
};
