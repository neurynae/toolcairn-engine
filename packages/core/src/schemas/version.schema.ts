import { z } from 'zod';

const rangeSystemSchema = z.enum([
  'semver',
  'pep440',
  'maven',
  'composer',
  'ruby',
  'cargo',
  'opaque',
]);

export const peerConstraintSchema = z.object({
  packageName: z.string().min(1).max(200),
  range: z.string().min(1).max(500),
  rangeSystem: rangeSystemSchema,
  kind: z.enum(['peer', 'optional_peer', 'dep']),
});

export const engineConstraintSchema = z.object({
  runtime: z.string().min(1).max(100),
  range: z.string().min(1).max(500),
  rangeSystem: rangeSystemSchema,
});

export const versionMetadataSchema = z.object({
  registry: z.string().min(1),
  packageName: z.string().min(1).max(300),
  version: z.string().min(1).max(100),
  releaseDate: z.string().optional(),
  isStable: z.boolean().default(true),
  deprecated: z.boolean().optional(),
  source: z.enum(['declared_dependency', 'deps_dev', 'version_only']),
  peers: z.array(peerConstraintSchema).default([]),
  engines: z.array(engineConstraintSchema).default([]),
});

export type PeerConstraint = z.infer<typeof peerConstraintSchema>;
export type EngineConstraint = z.infer<typeof engineConstraintSchema>;
export type VersionMetadata = z.infer<typeof versionMetadataSchema>;
