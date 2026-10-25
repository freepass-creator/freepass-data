export const logRouteError = (route, stage, error) => {
    const candidate = error;
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
