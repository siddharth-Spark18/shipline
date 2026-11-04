import api, { API_ORIGIN } from '@/lib/api';
import { CurrentUser } from './auth.types';

export class AuthService {
  static async getMe() {
    const { data } = await api.get<CurrentUser>('/auth/me');
    return data;
  }

  static async logout() {
    await api.post<void>('/auth/logout');
  }

  // Google SSO is a redirect, not a fetch.
  static signInWithGoogle() {
    window.location.href = `${API_ORIGIN}/api/auth/google/start`;
  }

  // One-time GitHub link (captures the GitHub username) is also a redirect.
  static connectGithub() {
    const token = localStorage.getItem('auth_token') ?? '';
    window.location.href = `${API_ORIGIN}/api/auth/github/connect?token=${encodeURIComponent(token)}`;
  }
}
