import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export default function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6', className)}>{children}</div>;
}
