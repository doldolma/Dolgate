export function shouldRequestSingleInstanceLock(input: {
  isPackaged: boolean;
  allowMultiInstanceEnv?: string;
}): boolean {
  if (input.allowMultiInstanceEnv === "1") {
    return false;
  }
  return input.isPackaged;
}
