import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { enableBuiltInsForProject, seedBuiltInTemplates } from '../src/services/template.service';

// The built-in Feature and Hotfix templates are seed data (packages/shared/src/stages.ts): they are
// created once, as version 1 of an ordinary template, and edited in Admin afterwards. Re-running the
// seed never overwrites an admin's edits (a template that exists is left alone). Projects that have
// no template enabled yet get the built-ins, with Feature as the default. It also gives Learnloop
// its chat key prefix.
async function main(): Promise<void> {
  const created = await seedBuiltInTemplates();
  console.log(created.length > 0 ? `Seeded templates: ${created.join(', ')}` : 'Built-in templates already exist: left as they are');

  for (const project of await prisma.project.findMany({ select: { id: true } })) await enableBuiltInsForProject(project.id);

  // Chats get per-project keys (LL-12). Projects are registered in the app (they need a GitHub repo
  // and an admin), so the seed does not create Learnloop; it sets the prefix on the registered one.
  // OPEN-QUESTION: projects are matched by name, case-insensitively. Re-run the seed after
  // registering Learnloop, or set the prefix under Project settings.
  const learnloop = await prisma.project.updateMany({
    where: { name: { equals: 'Learnloop', mode: 'insensitive' } },
    data: { keyPrefix: 'LL' },
  });
  console.log(learnloop.count > 0 ? 'Set key prefix LL on Learnloop' : 'No project named Learnloop yet: register it, then re-run the seed (or set its key prefix in project settings)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
