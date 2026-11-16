import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { API_PREFIX } from '@mahilasathi/shared';
import type { AppConfig } from './config/index.js';
import type { Db } from './db/connection.js';
import { attachSession } from './middleware/auth.js';
import { apiNotFound, errorHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { requireTrustedOrigin } from './middleware/sameOrigin.js';
import { createAuditRepository } from './repositories/auditRepository.js';
import { createAuthRepository } from './repositories/authRepository.js';
import { createEmergencyContactRepository } from './repositories/emergencyContactRepository.js';
import { createUserRepository } from './repositories/userRepository.js';
import { authRouter } from './routes/auth.js';
import { geoRouter } from './routes/geo.js';
import { systemRouter } from './routes/system.js';
import { usersRouter } from './routes/users.js';
import { createAuthService } from './services/auth/authService.js';
import { createOtpProvider, type OtpProvider } from './services/auth/otpProvider.js';
import { GeoRegistry } from './services/geography/geoRegistry.js';
import { createGeoService } from './services/geography/geoService.js';
import { createGeoapifyGeocoder } from './services/geography/providers/geoapifyGeocoder.js';
import type { GeocodingProvider } from './services/geography/providers/types.js';
import { createSystemService } from './services/system/systemService.js';
import { createUserService } from './services/users/userService.js';
import { systemClock, type Clock } from './utils/crypto.js';
import { createCircleRepository } from './repositories/circleRepository.js';
import { createCommunityRepository } from './repositories/communityRepository.js';
import { createSafetyRepository } from './repositories/safetyRepository.js';
import { circlesRouter } from './routes/circles.js';
import { communityRouter } from './routes/community.js';
import { safetyRouter } from './routes/safety.js';
import { webhooksRouter } from './routes/webhooks.js';
import { createCircleService } from './services/circles/circleService.js';
import { createDevRelayProvider, createNexconnProvider, type ChatProvider } from './services/community/chatProvider.js';
import { createCommunityService } from './services/community/communityService.js';
import { createMessagePolicy } from './services/moderation/messagePolicy.js';
import { createSafetyService } from './services/moderation/safetyService.js';
import { NEXCONN_BROWSER_HOSTS, createNexconnServerApi, type NexconnServerApi } from './services/nexconn/nexconnServerApi.js';
import { createNexconnWebhookHandler } from './services/nexconn/webhookHandler.js';
import { createRoutingRepository } from './repositories/routingRepository.js';
import { routingRouter } from './routes/routing.js';
import { createGeoapifyPlaces, createGeoapifyRouting, createOverpassCameras, createSyntheticRouting, type CameraProvider, type PlacesProvider, type RoutingProvider } from './services/routing/providers.js';
import { createRoutePlanningService } from './services/routing/routePlanningService.js';
import { createPulseRepository } from './repositories/pulseRepository.js';
import { createTripRepository } from './repositories/tripRepository.js';
import { createWalkTogetherRepository } from './repositories/walkTogetherRepository.js';
import { journeysRouter, pulseRouter } from './routes/journeys.js';
import { createTripService } from './services/journeys/tripService.js';
import { createWalkTogetherService } from './services/journeys/walkTogetherService.js';
import { createPulseService } from './services/pulse/pulseService.js';
import { createPrivacyRepository } from './repositories/privacyRepository.js';
import { createSosRepository } from './repositories/sosRepository.js';
import { privacyRouter } from './routes/privacy.js';
import { sosRouter } from './routes/sos.js';
import { createPrivacyService } from './services/privacy/privacyService.js';
import { createSmsProvider, type SmsProvider } from './services/sos/smsProvider.js';
import { createSosService } from './services/sos/sosService.js';
import { createCoverageService } from './services/geography/coverageService.js';
import { pushRouter } from './routes/push.js';
import { createPushService, createWebPushSender, type PushSender } from './services/push/pushService.js';
import { createDemoSeeder } from './services/demo/demoSeeder.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  migrationsDir: string;
  /** Directory containing the built client. Static serving is skipped when it has no index.html. */
  clientDistDir: string;
  /** Overrides for tests. Defaults are built from config. */
  clock?: Clock;
  otpProvider?: OtpProvider;
  geocoder?: GeocodingProvider | null;
  /** Replaces the Nexconn server API (tests). Only used when Nexconn keys are configured. */
  nexconnApi?: NexconnServerApi;
  /** Replace route-planning providers (tests). null disables a provider. */
  routingProviders?: { routing?: RoutingProvider; places?: PlacesProvider | null; cameras?: CameraProvider | null };
  /** Replaces the SMS provider used for SOS alerts to emergency contacts (tests). */
  smsProvider?: SmsProvider;
  /** Replaces the Web Push sender (tests). */
  pushSender?: PushSender;
}

export interface AppServices {
  registry: GeoRegistry;
  auth: ReturnType<typeof createAuthService>;
  community: ReturnType<typeof createCommunityService>;
  chatProvider: ChatProvider;
  planning: ReturnType<typeof createRoutePlanningService>;
  pulse: ReturnType<typeof createPulseService>;
  trips: ReturnType<typeof createTripService>;
  walk: ReturnType<typeof createWalkTogetherService>;
  sos: ReturnType<typeof createSosService>;
  privacy: ReturnType<typeof createPrivacyService>;
  coverage: ReturnType<typeof createCoverageService>;
  push: ReturnType<typeof createPushService>;
  /** Demo accounts (refuses unless DEMO_MODE=true). Used by `npm run demo:seed` and tests. */
  demo: ReturnType<typeof createDemoSeeder>;
}

export function createApp(deps: AppDeps): Express & { services: AppServices } {
  const { config, db, logger } = deps;
  const app = express() as Express & { services: AppServices };
  const clock = deps.clock ?? systemClock;
  const isTest = config.env === 'test';

  const audit = createAuditRepository(db);
  const users = createUserRepository(db);
  const registry = new GeoRegistry(db);
  const auth = createAuthService({
    authRepo: createAuthRepository(db),
    users,
    audit,
    otpProvider: deps.otpProvider ?? createOtpProvider(config),
    secret: config.jwtSecret,
    clock,
  });
  const userService = createUserService({ users, contacts: createEmergencyContactRepository(db), audit, registry, clock });
  const geocoder =
    deps.geocoder !== undefined ? deps.geocoder : config.geoapify.apiKey ? createGeoapifyGeocoder(config.geoapify.apiKey) : null;
  const geo = createGeoService({ registry, provider: geocoder, logger });

  // ─── Community (Nexconn when configured; labelled development relay otherwise) ──
  const communityRepo = createCommunityRepository(db);
  const safetyRepo = createSafetyRepository(db);
  const { appKey, appSecret } = config.nexconn;
  const nexconnConfigured = Boolean(appKey && appSecret);
  const chatProvider: ChatProvider = nexconnConfigured
    ? createNexconnProvider(deps.nexconnApi ?? createNexconnServerApi({ appKey: appKey!, appSecret: appSecret!, hosts: config.nexconn.apiHosts }))
    : createDevRelayProvider(communityRepo, clock);
  const policy = createMessagePolicy({ community: communityRepo, safety: safetyRepo, clock });
  const community = createCommunityService({
    repo: communityRepo,
    safety: safetyRepo,
    audit,
    registry,
    provider: chatProvider,
    policy,
    nexconnPublic: nexconnConfigured ? { appKey: appKey!, areaCode: config.nexconn.area } : null,
    clock,
    logger,
  });
  const circleService = createCircleService({
    circles: createCircleRepository(db),
    community: communityRepo,
    communityService: community,
    safety: safetyRepo,
    audit,
    secret: config.jwtSecret,
    clock,
  });
  const safetyService = createSafetyService({ safety: safetyRepo, community: communityRepo, communityService: community, circleService, audit, clock, logger });
  const webhookHandler = nexconnConfigured ? createNexconnWebhookHandler({ community: communityRepo, users, policy, clock, logger }) : null;
  // ─── Route planning (Geoapify when configured; labelled synthetic routes otherwise) ──
  const geoKey = config.geoapify.apiKey;
  const pulseRepo = createPulseRepository(db);
  const pulse = createPulseService({ repo: pulseRepo, safety: safetyRepo, registry, audit, clock });
  const planning = createRoutePlanningService({
    pulse,
    registry,
    repo: createRoutingRepository(db),
    routing: deps.routingProviders?.routing ?? (geoKey ? createGeoapifyRouting(geoKey) : createSyntheticRouting()),
    places: deps.routingProviders?.places !== undefined ? deps.routingProviders.places : geoKey ? createGeoapifyPlaces(geoKey) : null,
    cameras: deps.routingProviders?.cameras !== undefined ? deps.routingProviders.cameras : isTest ? null : createOverpassCameras(),
    clock,
    logger,
  });
  // ─── Journeys and Walk Together ──
  const tripRepo = createTripRepository(db);
  const circleRepo = createCircleRepository(db);
  // ─── Push notifications (Web Push with VAPID when configured) ──
  const vapid = config.push.vapid;
  const push = createPushService({ db, users, sender: deps.pushSender ?? (vapid ? createWebPushSender(vapid) : null), publicKey: vapid?.publicKey ?? (deps.pushSender ? 'test-public-key' : null), clock, logger });
  const trips = createTripService({ trips: tripRepo, circles: circleRepo, users, planning, pulse, community, registry, audit, clock, logger, push, demoMode: config.demoMode });
  const walk = createWalkTogetherService({ repo: createWalkTogetherRepository(db), trips: tripRepo, users, safety: safetyRepo, community, areaName: pulse.areaName, audit, clock, push });
  trips.onEnded((t) => walk.tripEnded(t.id));
  // ─── SOS (durable; delivered by the worker) and privacy controls ──
  const sms = deps.smsProvider ?? createSmsProvider(config, db, clock);
  const sos = createSosService({
    repo: createSosRepository(db),
    trips: tripRepo,
    circles: circleRepo,
    contacts: createEmergencyContactRepository(db),
    users,
    community,
    sms,
    registry,
    audit,
    clock,
    logger,
    push,
    demoMode: config.demoMode,
  });
  const privacy = createPrivacyService({ repo: createPrivacyRepository(db), pulseRepo, pulse, sos, audit, clock });
  const coverage = createCoverageService({ db, registry, planning, hasPlaceProvider: deps.routingProviders?.places !== undefined ? deps.routingProviders.places !== null : Boolean(geoKey), clock, logger });
  const demo = createDemoSeeder({ config, users, userService, circles: circleService, community, planning, trips, walk, sos, coverage });
  app.services = { registry, auth, community, chatProvider, planning, pulse, trips, walk, sos, privacy, demo, coverage, push };

  app.disable('x-powered-by');
  app.set('trust proxy', config.isProduction ? config.trustProxy : false);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      // Query strings can carry coordinates or search text; log the path only.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': ["'self'", 'data:', 'blob:'],
          'worker-src': ["'self'", 'blob:'],
          // The Nexconn Web SDK discovers and connects to its edge servers from the browser.
          'connect-src': ["'self'", ...(nexconnConfigured ? NEXCONN_BROWSER_HOSTS[config.nexconn.area] : [])],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use((_req, res, next) => {
    // Location is requested by the app itself only; deny camera/mic until a feature needs them.
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
    next();
  });

  // ─── API ────────────────────────────────────────────────────────────────────
  const api = express.Router();
  api.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
      maxAge: 600,
    }),
  );
  api.use(express.json({ limit: '100kb' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const system = createSystemService({ config, db, migrationsDir: deps.migrationsDir, registry });
  // Health and readiness are polled by infrastructure, so they sit outside the rate limiter.
  api.use(systemRouter(system));
  // Nexconn calls the webhook for every message from a handful of IPs: signature-authenticated, not IP-limited.
  api.use(webhooksRouter({ appSecret: nexconnConfigured ? appSecret : null, handler: webhookHandler, clock }));
  api.use(createRateLimiter({ windowMs: 60_000, limit: isTest ? 10_000 : 300 }));
  api.use(requireTrustedOrigin(config.corsOrigins));
  api.use(attachSession(auth));
  api.use(authRouter({ auth, userService, secureCookies: config.isProduction, ipLimit: isTest ? 10_000 : 30 }));
  api.use(usersRouter({ userService, secureCookies: config.isProduction }));
  api.use(geoRouter({ registry, geo, coverage, searchLimit: isTest ? 10_000 : 60 }));
  api.use(communityRouter({ community, sessionLimit: isTest ? 10_000 : 30 }));
  api.use(circlesRouter({ circles: circleService, acceptLimit: isTest ? 10_000 : 10 }));
  api.use(routingRouter({ planning, geoapifyKey: deps.routingProviders ? null : geoKey, planLimit: isTest ? 10_000 : 30, tileLimit: isTest ? 10_000 : 3000 }));
  api.use(journeysRouter({ trips, walk, locationLimit: isTest ? 10_000 : 12 }));
  api.use(pulseRouter({ pulse, adminToken: config.adminToken, reportLimit: isTest ? 10_000 : 10 }));
  api.use(sosRouter({ sos, locationLimit: isTest ? 10_000 : 12, adminToken: config.adminToken }));
  api.use(pushRouter({ push, testLimit: isTest ? 10_000 : 5 }));
  api.use(privacyRouter({ privacy, audit, adminToken: config.adminToken, exportLimit: isTest ? 10_000 : 5 }));
  api.use(safetyRouter({ safety: safetyService, adminToken: config.adminToken, reportLimit: isTest ? 10_000 : 20 }));
  api.use(apiNotFound);

  app.use(API_PREFIX, api);

  // ─── Client (single deployable) ────────────────────────────────────────────
  const indexHtml = path.join(deps.clientDistDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      '/assets',
      express.static(path.join(deps.clientDistDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }),
    );
    app.use(express.static(deps.clientDistDir, { index: false, maxAge: '1h' }));
    // SPA fallback: any other GET that wants HTML gets index.html so client routes deep-link.
    app.get('/{*splat}', (req, res, next) => {
      if (!req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    logger.warn({ clientDistDir: deps.clientDistDir }, 'client build not found; serving API only');
    app.get('/', (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('mahilaSathi API is running, but the client is not built. Run `npm run build`, or use `npm run dev`.');
    });
  }

  app.use(errorHandler);
  return app;
}
