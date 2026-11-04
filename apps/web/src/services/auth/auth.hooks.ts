import { useQuery } from '@tanstack/react-query';
import { AuthService } from './auth.service';
import { authKeys } from './auth.types';

export function useMe(enabled: boolean) {
  return useQuery({ queryKey: authKeys.me(), queryFn: AuthService.getMe, enabled });
}
