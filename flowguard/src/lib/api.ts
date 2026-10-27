export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: any,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.startsWith('/login')) window.dispatchEvent(new CustomEvent('fg:unauthenticated'));
    throw new ApiError(res.status, body?.error ?? 'ERROR', body?.message ?? `Request failed (${res.status})`, body);
  }
  return body as T;
}

export const api = {
  get: <T = any>(url: string) => fetch(url, { credentials: 'same-origin' }).then((r) => handle<T>(r)),
  send: <T = any>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => handle<T>(r)),
  post: <T = any>(url: string, body?: unknown) => api.send<T>('POST', url, body),
  put: <T = any>(url: string, body?: unknown) => api.send<T>('PUT', url, body),
  patch: <T = any>(url: string, body?: unknown) => api.send<T>('PATCH', url, body),
  del: <T = any>(url: string) => api.send<T>('DELETE', url),
  upload: <T = any>(url: string, form: FormData) => fetch(url, { method: 'POST', credentials: 'same-origin', body: form }).then((r) => handle<T>(r)),
};
