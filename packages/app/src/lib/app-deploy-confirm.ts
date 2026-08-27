/** Returns true when the user accepts deploying a public (no-login) app. */
export const publicDeployConfirm = {
  run: (message: string): boolean => window.confirm(message),
};
