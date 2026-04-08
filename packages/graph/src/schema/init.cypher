// ToolPilot Graph Schema — Memgraph constraints and indexes
// Run this on startup to initialize the graph schema.
// Syntax: Memgraph 3.x classic Cypher constraint/index syntax

// ─── Constraints ────────────────────────────────────────────────────────────

// Tools: unique name
CREATE CONSTRAINT ON (t:Tool) ASSERT t.name IS UNIQUE;

// UseCases: unique name
CREATE CONSTRAINT ON (u:UseCase) ASSERT u.name IS UNIQUE;

// Stacks: unique name
CREATE CONSTRAINT ON (s:Stack) ASSERT s.name IS UNIQUE;

// Patterns: unique name
CREATE CONSTRAINT ON (p:Pattern) ASSERT p.name IS UNIQUE;

// Requirements: unique name
CREATE CONSTRAINT ON (r:Requirement) ASSERT r.name IS UNIQUE;

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Tool lookups by category
CREATE INDEX ON :Tool(category);

// Tool lookups by primary language
CREATE INDEX ON :Tool(language);
