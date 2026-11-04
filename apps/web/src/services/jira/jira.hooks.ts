import { useQuery } from '@tanstack/react-query';
import { JiraService } from './jira.service';
import { jiraKeys } from './jira.types';

export function useJiraStatus() {
  return useQuery({ queryKey: jiraKeys.status(), queryFn: JiraService.getStatus });
}
