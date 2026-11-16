import { STATE_LABEL } from '@/components/banners';
import { projectLabel } from '@/components/chat-row';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Project } from '@/lib/types';

/**
 * The project dropdown at the top of the new-chat screen and of Setup. With `onlyOk` (new chat) the projects that
 * aren't served are listed but disabled, with their state.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  onlyOk = false,
  label = 'Project',
}: {
  projects: Project[];
  value: string | null;
  onChange: (id: string) => void;
  onlyOk?: boolean;
  label?: string;
}) {
  const sorted = [...projects].sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <Select value={value ?? undefined} onValueChange={onChange}>
        <SelectTrigger className="min-w-0 max-w-full" aria-label={label}>
          <SelectValue placeholder="Pick a project" />
        </SelectTrigger>
        <SelectContent>
          {sorted.map((p) => {
            const state = STATE_LABEL[p.state];
            return (
              <SelectItem key={p.id} value={p.id} disabled={onlyOk && p.state !== 'ok'}>
                {projectLabel(p)}
                {p.branch ? ` · ${p.branch}` : ''}
                {state ? ` (${state})` : ''}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
