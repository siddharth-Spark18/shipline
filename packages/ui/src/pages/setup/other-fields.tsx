import { ChevronRightIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/** Read-only list of the keys the form does not edit. They are kept as they are on save. */
export function OtherFields({ value, known }: { value: Record<string, unknown>; known: string[] }) {
  const entries = Object.entries(value).filter(([k]) => !known.includes(k));
  if (entries.length === 0) return null;
  return (
    <Collapsible className="rounded-md border px-3 py-2">
      <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />
        Other fields (kept) ({entries.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-muted-foreground">{k}</dt>
              <dd className="font-mono break-all whitespace-pre-wrap">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
