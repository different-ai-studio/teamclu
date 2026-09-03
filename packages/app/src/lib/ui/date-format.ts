import { getPreferredLanguage } from '@/lib/locale'

/**
 * Format a date according to the current locale
 */
export const formatDate = (date: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string => {
  const lang = getPreferredLanguage();
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  // Default options if none provided
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.DateTimeFormat(lang, formatOptions).format(dateObj);
};

/**
 * Format time according to the current locale
 */
export const formatTime = (date: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string => {
  const lang = getPreferredLanguage();
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  // Default time options
  const defaultOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.DateTimeFormat(lang, formatOptions).format(dateObj);
};

/**
 * Format datetime according to the current locale
 */
export const formatDateTime = (date: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string => {
  const lang = getPreferredLanguage();
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  // Default datetime options
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.DateTimeFormat(lang, formatOptions).format(dateObj);
};

/**
 * Format a date as a short relative time string (e.g., "Just now", "5m ago", "3d ago").
 * Pure function — safe to use outside React components.
 */
export function formatRelativeDate(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

/**
 * Format a date as a session grouping label: "Today", "Yesterday", or "N days ago".
 */
export function formatSessionDate(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000)

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return `${diffDays} days ago`
}

/**
 * Format relative time as an ultra-compact, locale-aware string suitable for
 * tight list rows (e.g. "刚刚" / "2分", "now" / "2m" / "3h" / "2d").
 * Unlike formatRelativeTime ("2 minutes ago"), this stays a few characters wide
 * so it never crowds out the adjacent name in narrow columns.
 */
export const formatRelativeTimeShort = (date: Date | string | number): string => {
  const lang = getPreferredLanguage();
  const isZh = lang === 'zh' || lang === 'zh-CN';
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const diffInSeconds = Math.floor((Date.now() - dateObj.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return isZh ? '刚刚' : 'now';
  } else if (diffInSeconds < 3600) {
    const m = Math.floor(diffInSeconds / 60);
    return isZh ? `${m}分` : `${m}m`;
  } else if (diffInSeconds < 86400) {
    const h = Math.floor(diffInSeconds / 3600);
    return isZh ? `${h}时` : `${h}h`;
  } else if (diffInSeconds < 2592000) { // 30 days
    const d = Math.floor(diffInSeconds / 86400);
    return isZh ? `${d}天` : `${d}d`;
  } else if (diffInSeconds < 31536000) { // 365 days
    const mo = Math.floor(diffInSeconds / 2592000);
    return isZh ? `${mo}月` : `${mo}mo`;
  } else {
    const y = Math.floor(diffInSeconds / 31536000);
    return isZh ? `${y}年` : `${y}y`;
  }
};

/**
 * Format relative time (e.g., "2 hours ago")
 */
export const formatRelativeTime = (date: Date | string | number): string => {
  const lang = getPreferredLanguage();
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - dateObj.getTime()) / 1000);
  
  // Define thresholds in seconds
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  
  if (diffInSeconds < 60) {
    return lang === 'zh' || lang === 'zh-CN' ? '刚刚' : 'Just now';
  } else if (diffInSeconds < 3600) {
    return rtf.format(-Math.floor(diffInSeconds / 60), 'minute');
  } else if (diffInSeconds < 86400) {
    return rtf.format(-Math.floor(diffInSeconds / 3600), 'hour');
  } else if (diffInSeconds < 2592000) { // 30 days
    return rtf.format(-Math.floor(diffInSeconds / 86400), 'day');
  } else if (diffInSeconds < 31536000) { // 365 days
    return rtf.format(-Math.floor(diffInSeconds / 2592000), 'month');
  } else {
    return rtf.format(-Math.floor(diffInSeconds / 31536000), 'year');
  }
};
