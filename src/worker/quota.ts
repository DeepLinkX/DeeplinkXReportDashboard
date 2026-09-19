export function isD1DailyQuotaError(error: unknown): boolean {
  return error instanceof Error && /D1.*free tier daily row (?:read|write) limit/i.test(error.message);
}

export function quotaResetDelay(date = new Date()): number {
  const reset = Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+1,0,1);
  return Math.min(43200,Math.max(60,Math.ceil((reset-date.getTime())/1000)));
}
