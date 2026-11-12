import { useState, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from 'cn';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * A fenced code block on a phone: full width, long lines scroll sideways, and a small Wrap toggle
 * wraps them instead.
 */
function CodeBlock({
  children,
  className,
  node: _node,
  ...rest
}: ComponentProps<'pre'> & { node?: unknown }) {
  const [wrap, setWrap] = useState(false);
  return (
    <div className="relative">
      <pre
        {...rest}
        className={cn(
          'max-w-full',
          wrap ? 'whitespace-pre-wrap [&_code]:[white-space:inherit] [&_code]:break-words' : '',
          className,
        )}
      >
        {children}
      </pre>
      <button
        type="button"
        aria-pressed={wrap}
        onClick={() => setWrap((w) => !w)}
        className={cn(
          'absolute top-1.5 right-1.5 flex h-7 items-center rounded-md border px-2 text-[11px] font-medium',
          wrap
            ? 'border-primary/40 bg-accent text-accent-foreground'
            : 'bg-card text-muted-foreground',
        )}
      >
        Wrap
      </button>
    </div>
  );
}

const MOBILE_COMPONENTS: Components = { pre: CodeBlock };

/** Renders markdown with GitHub extensions. Raw HTML in the source is dropped, never rendered. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  const mobile = useIsMobile();
  return (
    <div className={cn('prose prose-sm max-w-none dark:prose-invert', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={mobile ? MOBILE_COMPONENTS : undefined}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
