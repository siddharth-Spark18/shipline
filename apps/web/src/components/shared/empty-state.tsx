import { ReactNode } from 'react';

export default function EmptyState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
      <p>{message}</p>
      {children}
    </div>
  );
}
