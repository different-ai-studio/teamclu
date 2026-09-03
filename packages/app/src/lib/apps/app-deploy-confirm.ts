export const PUBLIC_DEPLOY_CONFIRM_MESSAGE =
  "此应用未启用登录保护，任何拿到链接的人都能访问。\n\n确定继续部署吗？";

/** Shown when the app's workspace has an agent turn in flight (§4.2). */
export const ACTIVE_TURN_DEPLOY_CONFIRM_MESSAGE =
  "此应用的工作区有 AI 正在运行。现在部署可能把未完成的改动打包上线。\n\n确定继续部署吗？";

export interface DeployConfirmPrompt {
  message: string;
}

type DeployConfirmHandler = (prompt: DeployConfirmPrompt) => Promise<boolean>;

let handler: DeployConfirmHandler | null = null;

/** Wired by {@link AppDeployConfirmDialog} at app root. */
export function registerDeployConfirmHandler(next: DeployConfirmHandler | null): void {
  handler = next;
}

/** Returns true when the user accepts a deploy checkpoint dialog. */
export const publicDeployConfirm = {
  async run(message: string): Promise<boolean> {
    if (handler) return handler({ message });
    // Vitest / pre-mount fallback (browser dev without the host mounted).
    return window.confirm(message);
  },
};
