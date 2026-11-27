export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

export function WechatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="#07C160" aria-hidden="true">
      <path d="M8.69 4C4.86 4 1.75 6.61 1.75 9.83c0 1.8.98 3.41 2.52 4.49l-.63 1.9 2.2-1.1c.79.22 1.6.36 2.45.4-.1-.43-.16-.87-.16-1.32 0-3.05 2.96-5.4 6.46-5.4.23 0 .46.02.68.04C14.9 5.77 12.07 4 8.69 4Zm-2.3 3.1a.86.86 0 1 1 0 1.72.86.86 0 0 1 0-1.72Zm4.6 0a.86.86 0 1 1 0 1.72.86.86 0 0 1 0-1.72Z" />
      <path d="M22.25 14.07c0-2.7-2.62-4.9-5.85-4.9-3.34 0-5.86 2.32-5.86 4.96 0 2.65 2.52 4.9 5.86 4.9.72 0 1.42-.12 2.07-.32l1.86.93-.52-1.6c1.45-.94 2.44-2.36 2.44-3.97Zm-7.74-1.06a.72.72 0 1 1 0-1.44.72.72 0 0 1 0 1.44Zm3.78 0a.72.72 0 1 1 0-1.44.72.72 0 0 1 0 1.44Z" />
    </svg>
  );
}

/**
 * WeCom sign-in. A plain enterprise-chat glyph in WeCom's blue rather than the
 * WeCom logo itself.
 */
export function WecomIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="#0082EF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z" />
      <path d="M16 9.5h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1v2.5L16 17.5h-3" />
    </svg>
  );
}
