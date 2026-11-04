import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/auth-context';
import PageContainer from '@/components/layout/page-container';
import PageLoading from '@/components/shared/page-loading';

// The API redirects here with the session token in the URL fragment (never sent to a server).
export default function AuthCallbackPage() {
  const { setToken } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (token) {
      setToken(token);
      navigate('/', { replace: true });
    } else {
      navigate('/login?error=invalid_state', { replace: true });
    }
  }, [setToken, navigate]);

  return (
    <PageContainer>
      <PageLoading />
    </PageContainer>
  );
}
