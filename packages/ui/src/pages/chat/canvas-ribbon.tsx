import { useState } from 'react';
import { ListChecksIcon, PanelRightOpenIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { StageDot, STATUS_LABEL } from '@/components/stage-dots';
import { TaskCanvas } from '@/components/task-panel';
import type { Change, Task } from '@/lib/types';

/**
 * The collapsed Task canvas: a narrow ribbon with one dot per stage. Used below 1200px and when
 * the chat has no task. The button opens the full canvas in a Sheet, so nothing is lost.
 */
export function CanvasRibbon({ task, changes }: { task?: Task; changes: Change[] }) {
  const [open, setOpen] = useState(false);
  return (
    <aside
      aria-label="Task canvas"
      className="flex w-11 shrink-0 flex-col items-center gap-3 border-l bg-sidebar py-3"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open task canvas"
            onClick={() => setOpen(true)}
          >
            <PanelRightOpenIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Open task canvas</TooltipContent>
      </Tooltip>
      {task ? (
        task.stages.map((s) => (
          <StageDot key={s.id} status={s.status} title={`${s.name}: ${STATUS_LABEL[s.status]}`} />
        ))
      ) : (
        <ListChecksIcon className="size-4 text-muted-foreground" aria-label="No task yet" />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle>Task canvas</SheetTitle>
            <SheetDescription>Progress, artifacts and changes for this chat.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            <TaskCanvas task={task} changes={changes} />
          </div>
        </SheetContent>
      </Sheet>
    </aside>
  );
}
