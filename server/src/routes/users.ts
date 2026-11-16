import { Router } from 'express';
import { z } from 'zod';
import {
  createEmergencyContactSchema,
  deleteAccountSchema,
  updateEmergencyContactSchema,
  updateMeSchema,
  updatePreferencesSchema,
} from '@mahilasathi/shared';
import { clearSessionCookie, currentAuth, requireAuth } from '../middleware/auth.js';
import { parseBody, parseParams } from '../middleware/validate.js';
import type { UserService } from '../services/users/userService.js';

const idParams = z.object({ id: z.string().uuid() });

export function usersRouter(deps: { userService: UserService; secureCookies: boolean }): Router {
  const { userService } = deps;
  const router = Router();
  router.use('/users/me', requireAuth);

  router.get('/users/me', (req, res) => {
    res.json(userService.toMe(currentAuth(req).user));
  });

  router.patch('/users/me', (req, res) => {
    res.json(userService.updateMe(currentAuth(req).user, parseBody(req, updateMeSchema), req.id));
  });

  router.delete('/users/me', (req, res) => {
    parseBody(req, deleteAccountSchema);
    userService.deleteAccount(currentAuth(req).user.id, req.id);
    clearSessionCookie(res, deps.secureCookies);
    res.status(204).end();
  });

  router.get('/users/me/preferences', (req, res) => {
    res.json(userService.getPreferences(currentAuth(req).user.id));
  });

  router.patch('/users/me/preferences', (req, res) => {
    res.json(userService.updatePreferences(currentAuth(req).user.id, parseBody(req, updatePreferencesSchema), req.id));
  });

  router.get('/users/me/emergency-contacts', (req, res) => {
    res.json({ contacts: userService.listContacts(currentAuth(req).user.id) });
  });

  router.post('/users/me/emergency-contacts', (req, res) => {
    res.status(201).json(userService.addContact(currentAuth(req).user, parseBody(req, createEmergencyContactSchema)));
  });

  router.patch('/users/me/emergency-contacts/:id', (req, res) => {
    const { id } = parseParams(req, idParams);
    res.json(userService.updateContact(currentAuth(req).user, id, parseBody(req, updateEmergencyContactSchema)));
  });

  router.delete('/users/me/emergency-contacts/:id', (req, res) => {
    const { id } = parseParams(req, idParams);
    userService.deleteContact(currentAuth(req).user.id, id);
    res.status(204).end();
  });

  return router;
}
