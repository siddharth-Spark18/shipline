import api, { API_ORIGIN } from '@/lib/api';
import { JiraStatus } from './jira.types';

export class JiraService {
  static async getStatus() {
    const { data } = await api.get<JiraStatus>('/jira/status');
    return data;
  }

  // Admin-only OAuth redirect; read-only scopes (Shipline never writes to Jira).
  static connect() {
    const token = localStorage.getItem('auth_token') ?? '';
    window.location.href = `${API_ORIGIN}/api/jira/connect?token=${encodeURIComponent(token)}`;
  }
}
