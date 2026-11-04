import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { handle } from '../lib/async-handler';
import { HttpError } from '../lib/http-error';
import { auth } from '../middleware/auth';
import { createChat, listChats } from '../services/chat.service';

// Chats are the work items. The workspace is chat-first: pick a project, type, and a chat with a
// per-project key (e.g. LL-12) exists right away. Jira is optional and linked by Claude later.
const router: Router = Router();
router.use(auth);

router.get(
  '/',
  handle(async (req, res) => {
    res.json(await listChats(req.user!.userId));
  }),
);

router.post(
  '/',
  [body('projectId').notEmpty(), body('message').isString().notEmpty().withMessage('Write the first message to start a chat'), body('templateId').optional().isString()],
  handle(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new HttpError(400, errors.array()[0].msg as string);
    const b = req.body as { projectId: string; message: string; templateId?: string };
    res.status(201).json(await createChat(req.user!.userId, b));
  }),
);

export default router;
