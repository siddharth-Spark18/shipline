import axios from 'axios';

export const API_ORIGIN: string = import.meta.env.VITE_API_URL ?? '';

const api = axios.create({ baseURL: `${API_ORIGIN}/api` });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const isAuthEndpoint = err.config?.url?.startsWith('/auth/');
    if (err.response?.status === 401 && !isAuthEndpoint) {
      localStorage.removeItem('auth_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error ?? err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export default api;

/** The `code` the API attaches to an error (e.g. STALE_TEMPLATE, AGENTS_MISSING), if any. */
export function errorCode(err: unknown): string | undefined {
  if (axios.isAxiosError(err)) return (err.response?.data as { code?: string } | undefined)?.code;
  return undefined;
}
