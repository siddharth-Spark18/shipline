import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export type SetupPath = 'claude' | 'here';

/** The first screen of the install wizard: set up with Claude's interview, or step through everything here. */
export function PathChoice({ onChoose }: { onChoose: (path: SetupPath) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set up with Claude</CardTitle>
          <CardDescription>
            Install Shipline&apos;s defaults, then Claude interviews you and tailors the workflows,
            rules and commands to this repo.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            Needs Claude Code installed and signed in.
          </p>
          <div>
            <Button onClick={() => onChoose('claude')}>Set up with Claude</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set up here</CardTitle>
          <CardDescription>
            Go through everything yourself in seven steps: workflows, stages and rules, agents,
            project settings, guardrails and the CI check. Nothing is written until you install.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            Starts from the same defaults. Finishing counts as setup done.
          </p>
          <div>
            <Button variant="outline" onClick={() => onChoose('here')}>
              Set up here
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
