import { useState } from 'react';
import { Bot, ChevronDown, ChevronUp, GripVertical, Pencil, Shield, Trash2 } from 'lucide-react';
import { STAGE_TYPE_LABELS, TemplateIssue } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EditorStage, moveItem } from '../editor-state';

interface StageListProps {
  stages: EditorStage[];
  issues: TemplateIssue[];
  /** Agent name by ref, for the row badge. */
  agentName: (ref: string) => string;
  onChange: (stages: EditorStage[]) => void;
  onEdit: (uid: string) => void;
}

/**
 * The template's stages in order. Drag a row by its handle to reorder (the arrow buttons do the same
 * from the keyboard); validation messages sit under the stage they are about.
 */
export default function StageList({ stages, issues, agentName, onChange, onEdit }: StageListProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const drop = (to: number) => {
    if (dragFrom !== null) onChange(moveItem(stages, dragFrom, to));
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <ol className="space-y-2">
      {stages.map((s, i) => {
        const own = issues.filter((issue) => issue.stageIndex === i);
        return (
          <li
            key={s.uid}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              setDragOver(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(i);
            }}
            className={cn(
              'rounded-lg border bg-card p-2 text-sm',
              own.length > 0 && 'border-destructive',
              dragOver === i && dragFrom !== null && dragFrom !== i && 'ring-2 ring-primary',
              dragFrom === i && 'opacity-50',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  setDragFrom(i);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                }}
                className="cursor-grab text-muted-foreground active:cursor-grabbing"
                title="Drag to reorder"
              >
                <GripVertical className="size-4" />
              </span>
              <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
              <button type="button" onClick={() => onEdit(s.uid)} className="min-w-0 flex-1 cursor-pointer text-left">
                <span className="font-medium">{s.name || 'Untitled stage'}</span>
                <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
                  <Badge variant="outline">{STAGE_TYPE_LABELS[s.type]}</Badge>
                  {s.optional && <Badge variant="outline">optional</Badge>}
                  {s.requiredForGate && <Badge variant="secondary">gate</Badge>}
                  {s.agentRef && (
                    <Badge variant="secondary">
                      <Bot /> {agentName(s.agentRef)}
                    </Badge>
                  )}
                  {s.rules.length > 0 && (
                    <Badge variant="secondary">
                      <Shield /> {s.rules.length} rule{s.rules.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                </span>
              </button>
              <Button size="icon-xs" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => onChange(moveItem(stages, i, i - 1))}>
                <ChevronUp />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label="Move down" disabled={i === stages.length - 1} onClick={() => onChange(moveItem(stages, i, i + 1))}>
                <ChevronDown />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => onEdit(s.uid)}>
                <Pencil />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => onChange(stages.filter((_, n) => n !== i))}>
                <Trash2 />
              </Button>
            </div>
            {own.map((issue, n) => (
              <p key={n} className="pt-1 pl-9 text-xs text-destructive">
                {issue.message}
              </p>
            ))}
          </li>
        );
      })}
    </ol>
  );
}
