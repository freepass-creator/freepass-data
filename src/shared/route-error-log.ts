export const logRouteError = (route: string, stage: string, error: unknown): void => {
  const candidate = error as { name?: unknown; code?: unknown } | undefined;
  console.error(JSON.stringify({
    event: 'route_error',
    route,
    stage,
    errorName: typeof candidate?.name === 'string'
      ? candidate.name
      : error instanceof Error ? error.name : 'NonError',
    ...(typeof candidate?.code === 'string' || typeof candidate?.code === 'number'
      ? { errorCode: candidate.code }
      : {}),
  }));
};
