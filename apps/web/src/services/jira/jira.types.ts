export const jiraKeys = {
  status: () => ['jira', 'status'] as const,
};

export interface JiraStatus {
  configured: boolean;
  connected: boolean;
  siteUrl: string | null;
  siteName: string | null;
}
