import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  OptimToolInput,
  PromptAnalysis,
  RepositoryComplexityMetrics,
  RepositoryIntelligence,
  RepositoryRelationship
} from "../types/index.js";

const execFileAsync = promisify(execFile);
const defaultGraphifyTimeoutMs = 3_500;
const defaultGraphifyQueryBudget = 1_200;
const maxContextChars = 2_400;
const maxQueryPromptChars = 700;

interface ParsedGraphNode {
  id: string;
  label: string;
  sourceFile?: string | undefined;
  fileType?: string | undefined;
  community?: string | undefined;
  degree: number;
}

interface ParsedGraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence?: string | undefined;
  confidenceScore?: number | undefined;
  sourceFile?: string | undefined;
  weight?: number | undefined;
}

interface ParsedGraph {
  nodes: ParsedGraphNode[];
  nodesById: Map<string, ParsedGraphNode>;
  edges: ParsedGraphEdge[];
  adjacency: Map<string, ParsedGraphEdge[]>;
  centralNodes: ParsedGraphNode[];
  communityCount: number;
}

interface CachedGraph {
  graphPath: string;
  mtimeMs: number;
  graph: ParsedGraph;
}

interface QueryResult {
  output: string;
  error?: string | undefined;
}

interface GraphifyContext {
  relatedFiles: string[];
  affectedModules: string[];
  dependencyRelationships: RepositoryRelationship[];
  architectureContext: string[];
  metrics: RepositoryComplexityMetrics;
  signals: string[];
}

const stopWords = new Set([
  "about",
  "after",
  "again",
  "before",
  "build",
  "change",
  "code",
  "could",
  "file",
  "from",
  "have",
  "into",
  "make",
  "model",
  "must",
  "need",
  "only",
  "please",
  "repo",
  "request",
  "should",
  "task",
  "that",
  "this",
  "with",
  "would"
]);

let cachedGraph: CachedGraph | undefined;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function difficultyFromScore(score: number): "simple" | "moderate" | "difficult" {
  if (score < 40) return "simple";
  if (score < 72) return "moderate";
  return "difficult";
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(): boolean {
  const value = process.env.OPTIM_GRAPHIFY_ENABLED;
  return !value || value.trim().toLowerCase() !== "false";
}

function resolveFrom(basePath: string, candidate: string): string {
  return isAbsolute(candidate) ? resolve(candidate) : resolve(basePath, candidate);
}

function resolveRepositoryRoot(input: OptimToolInput): string {
  const configured = input.repositoryPath ?? process.env.OPTIM_GRAPHIFY_REPOSITORY_ROOT ?? process.cwd();
  return resolve(configured);
}

function resolveGraphPath(input: OptimToolInput, repositoryRoot: string): string {
  const configured = input.graphPath ?? process.env.OPTIM_GRAPHIFY_GRAPH_PATH;
  return configured ? resolveFrom(repositoryRoot, configured) : resolve(repositoryRoot, "graphify-out", "graph.json");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function emptyMetrics(score = 0): RepositoryComplexityMetrics {
  const boundedScore = clamp(score);
  return {
    taskDifficulty: difficultyFromScore(boundedScore),
    score: boundedScore,
    reasoningDepthRequired: 0,
    architectureImpact: 0,
    dependencyComplexity: 0,
    connectedSystemsAffected: 0,
    relatedFileCount: 0,
    affectedModuleCount: 0
  };
}

function baseIntelligence(
  status: RepositoryIntelligence["status"],
  input: OptimToolInput,
  analysis: PromptAnalysis,
  summary: string,
  options: {
    queried?: boolean;
    error?: string | undefined;
    signals?: string[];
  } = {}
): RepositoryIntelligence {
  const repositoryRoot = resolveRepositoryRoot(input);
  const graphPath = resolveGraphPath(input, repositoryRoot);
  const query = buildGraphifyQuestion(input.prompt, analysis);

  return {
    provider: "graphify",
    status,
    repositoryRoot,
    graphPath,
    queried: options.queried ?? false,
    query,
    summary,
    relatedFiles: [],
    dependencyRelationships: [],
    affectedModules: [],
    architectureContext: [],
    metrics: emptyMetrics(),
    signals: options.signals ?? [`graphify:${status}`],
    ...(options.error ? { error: options.error } : {})
  };
}

function shouldUseGraphify(input: OptimToolInput, analysis: PromptAnalysis): boolean {
  if (!enabled()) {
    return false;
  }

  if (analysis.taskType === "coding") {
    return true;
  }

  const text = input.prompt.toLowerCase();
  return /\b(repo|repository|codebase|file|module|component|dependency|dependencies|architecture|implement|refactor|fix|debug|bug|test|mcp|provider|router|api|class|function)\b/.test(
    text
  );
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function endpointId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (value && typeof value === "object") {
    return readString(value as Record<string, unknown>, ["id", "label"]);
  }

  return undefined;
}

function normalizeSourceFile(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized || normalized === "." || normalized.toLowerCase() === "unknown") {
    return undefined;
  }

  return normalized;
}

function parseNodes(raw: unknown): ParsedGraphNode[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const id = readString(record, ["id", "key", "name"]);
    if (!id) {
      return [];
    }

    const label = readString(record, ["label", "name"]) ?? id;
    const sourceFile = normalizeSourceFile(readString(record, ["source_file", "sourceFile", "file"]));
    const fileType = readString(record, ["file_type", "fileType", "type"]);
    const community = readString(record, ["community", "cluster", "group"]);

    return [
      {
        id,
        label,
        ...(sourceFile ? { sourceFile } : {}),
        ...(fileType ? { fileType } : {}),
        ...(community ? { community } : {}),
        degree: 0
      }
    ];
  });
}

function parseEdges(raw: unknown): ParsedGraphEdge[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const source = endpointId(record.source);
    const target = endpointId(record.target);
    if (!source || !target) {
      return [];
    }

    const relation = readString(record, ["relation", "label", "type"]) ?? "related_to";
    const confidence = readString(record, ["confidence"]);
    const confidenceScore = readNumber(record, ["confidence_score", "confidenceScore"]);
    const sourceFile = normalizeSourceFile(readString(record, ["source_file", "sourceFile", "file"]));
    const weight = readNumber(record, ["weight"]);

    return [
      {
        source,
        target,
        relation,
        ...(confidence ? { confidence } : {}),
        ...(typeof confidenceScore === "number" ? { confidenceScore } : {}),
        ...(sourceFile ? { sourceFile } : {}),
        ...(typeof weight === "number" ? { weight } : {})
      }
    ];
  });
}

function parseGraph(raw: unknown): ParsedGraph {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nodes = parseNodes(record.nodes);
  const edges = parseEdges(record.links ?? record.edges);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, ParsedGraphEdge[]>();
  const degrees = new Map<string, number>();

  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);

    const sourceEdges = adjacency.get(edge.source) ?? [];
    sourceEdges.push(edge);
    adjacency.set(edge.source, sourceEdges);

    const targetEdges = adjacency.get(edge.target) ?? [];
    targetEdges.push(edge);
    adjacency.set(edge.target, targetEdges);
  }

  for (const node of nodes) {
    node.degree = degrees.get(node.id) ?? 0;
  }

  const communities = new Set(nodes.map((node) => node.community).filter((community): community is string => Boolean(community)));
  const centralNodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 8);

  return {
    nodes,
    nodesById,
    edges,
    adjacency,
    centralNodes,
    communityCount: communities.size
  };
}

async function loadGraph(graphPath: string): Promise<ParsedGraph> {
  const metadata = await stat(graphPath);
  if (cachedGraph && cachedGraph.graphPath === graphPath && cachedGraph.mtimeMs === metadata.mtimeMs) {
    return cachedGraph.graph;
  }

  const file = await readFile(graphPath, "utf8");
  const graph = parseGraph(JSON.parse(file) as unknown);
  cachedGraph = {
    graphPath,
    mtimeMs: metadata.mtimeMs,
    graph
  };
  return graph;
}

function buildGraphifyQuestion(prompt: string, analysis: PromptAnalysis): string {
  const compactPrompt = prompt.replace(/\s+/g, " ").trim().slice(0, maxQueryPromptChars);
  return [
    `Task type: ${analysis.taskType}.`,
    "Find related files, dependency relationships, affected modules, architecture context, and codebase complexity for this request:",
    compactPrompt
  ].join(" ");
}

async function runGraphifyQuery(query: string, graphPath: string, repositoryRoot: string): Promise<QueryResult> {
  const budget = numberFromEnv("OPTIM_GRAPHIFY_QUERY_BUDGET", defaultGraphifyQueryBudget);
  const timeout = numberFromEnv("OPTIM_GRAPHIFY_TIMEOUT_MS", defaultGraphifyTimeoutMs);

  try {
    const { stdout, stderr } = await execFileAsync(
      "graphify",
      ["query", query, "--budget", String(budget), "--graph", graphPath],
      {
        cwd: repositoryRoot,
        timeout,
        maxBuffer: 1_000_000,
        windowsHide: true
      }
    );

    return {
      output: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim()
    };
  } catch (error) {
    const candidate = error as { stdout?: unknown; stderr?: unknown; message?: string };
    const output = [candidate.stdout, candidate.stderr]
      .filter((value): value is string | Buffer => typeof value === "string" || Buffer.isBuffer(value))
      .map((value) => value.toString())
      .join("\n")
      .trim();

    return {
      output,
      error: candidate.message ?? (error instanceof Error ? error.message : String(error))
    };
  }
}

function extractTerms(prompt: string): string[] {
  const matches = prompt.toLowerCase().match(/[a-z0-9_./\\-]{3,}/g) ?? [];
  const terms = new Set<string>();

  for (const match of matches) {
    const normalized = match.replace(/\\/g, "/").replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, "");
    if (normalized.length < 3 || stopWords.has(normalized)) {
      continue;
    }

    terms.add(normalized);
    const basename = normalized.split("/").pop();
    if (basename && basename !== normalized && basename.length >= 3) {
      terms.add(basename);
    }
  }

  return [...terms].slice(0, 40);
}

function extractMentionedFiles(prompt: string): string[] {
  const pathMatches = prompt.match(/(?:[\w.-]+[\\/])+[\w.-]+(?:\.[\w]+)?/g) ?? [];
  const fileMatches = prompt.match(/\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cs|css|html)\b/g) ?? [];
  return uniqueStrings([...pathMatches, ...fileMatches].map((file) => file.replace(/\\/g, "/").toLowerCase()));
}

function extractFilesFromQuery(output: string): string[] {
  const files = new Set<string>();
  const sourcePattern = /\[src=([^\]\r\n]*?)(?:\s+loc=|\])/g;
  let match = sourcePattern.exec(output);

  while (match) {
    const file = normalizeSourceFile(match[1]);
    if (file) {
      files.add(file);
    }

    match = sourcePattern.exec(output);
  }

  return [...files];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function scoreNode(node: ParsedGraphNode, terms: string[], mentionedFiles: string[], queryFiles: string[]): number {
  const label = node.label.toLowerCase();
  const sourceFile = node.sourceFile?.toLowerCase() ?? "";
  const haystack = `${label} ${sourceFile}`;
  let score = 0;

  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.includes("/") || term.includes(".") ? 8 : 3;
    }
  }

  for (const file of mentionedFiles) {
    if (sourceFile.endsWith(file) || sourceFile.includes(file)) {
      score += 16;
    }
  }

  for (const file of queryFiles) {
    const normalized = file.toLowerCase();
    if (sourceFile === normalized || sourceFile.endsWith(normalized)) {
      score += 10;
    }
  }

  if (/\b(router|registry|provider|config|server|tool|engine|mcp|architecture|dependency)\b/.test(label)) {
    score += 2;
  }

  return score;
}

function edgeOtherNode(edge: ParsedGraphEdge, nodeId: string): string {
  return edge.source === nodeId ? edge.target : edge.source;
}

function selectRelevantNodeIds(graph: ParsedGraph, prompt: string, queryOutput: string): Set<string> {
  const terms = extractTerms(prompt);
  const mentionedFiles = extractMentionedFiles(prompt);
  const queryFiles = extractFilesFromQuery(queryOutput);

  const scored = graph.nodes
    .map((node) => ({ node, score: scoreNode(node, terms, mentionedFiles, queryFiles) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.node.degree - a.node.degree)
    .slice(0, 12)
    .map((entry) => entry.node.id);

  const selected = new Set(scored);

  if (selected.size === 0 && queryFiles.length > 0) {
    for (const node of graph.nodes) {
      const sourceFile = node.sourceFile?.toLowerCase();
      if (sourceFile && queryFiles.some((file) => sourceFile.endsWith(file.toLowerCase()))) {
        selected.add(node.id);
      }
    }
  }

  if (selected.size === 0) {
    for (const node of graph.centralNodes.slice(0, 6)) {
      selected.add(node.id);
    }
  }

  const expanded = new Set(selected);
  for (const nodeId of selected) {
    const edges = graph.adjacency.get(nodeId) ?? [];
    for (const edge of edges.slice(0, 8)) {
      expanded.add(edgeOtherNode(edge, nodeId));
    }
  }

  return expanded;
}

function moduleFromFile(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) {
    return parts[0] ?? file;
  }

  if (parts[0] === "src" || parts[0] === "dist") {
    return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
  }

  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || (parts[0] ?? file);
}

function relationPriority(relation: string): number {
  if (/\b(imports?|depends?_on|calls?|implements?|extends|shares_data_with|references?)\b/.test(relation)) {
    return 3;
  }

  if (/\b(conceptually_related_to|semantically_similar_to)\b/.test(relation)) {
    return 2;
  }

  return 1;
}

function relationshipFromEdge(graph: ParsedGraph, edge: ParsedGraphEdge): RepositoryRelationship {
  const source = graph.nodesById.get(edge.source);
  const target = graph.nodesById.get(edge.target);
  const sourceFile = source?.sourceFile ?? edge.sourceFile;
  const targetFile = target?.sourceFile;

  return {
    source: source?.label ?? edge.source,
    target: target?.label ?? edge.target,
    relation: edge.relation,
    ...(edge.confidence ? { confidence: edge.confidence } : {}),
    ...(typeof edge.confidenceScore === "number" ? { confidenceScore: edge.confidenceScore } : {}),
    ...(sourceFile ? { sourceFile } : {}),
    ...(targetFile ? { targetFile } : {})
  };
}

function collectRelationships(graph: ParsedGraph, selectedIds: Set<string>): RepositoryRelationship[] {
  const seen = new Set<string>();
  const relationships: Array<RepositoryRelationship & { priority: number }> = [];

  for (const edge of graph.edges) {
    if (!selectedIds.has(edge.source) && !selectedIds.has(edge.target)) {
      continue;
    }

    const key = `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    relationships.push({
      ...relationshipFromEdge(graph, edge),
      priority: relationPriority(edge.relation)
    });
  }

  return relationships
    .sort((a, b) => b.priority - a.priority || (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0))
    .slice(0, 24)
    .map(({ priority: _priority, ...relationship }) => relationship);
}

function collectFiles(graph: ParsedGraph, selectedIds: Set<string>, relationships: RepositoryRelationship[], queryOutput: string): string[] {
  const selectedFiles = [...selectedIds].map((id) => graph.nodesById.get(id)?.sourceFile);
  const relationshipFiles = relationships.flatMap((relationship) => [relationship.sourceFile, relationship.targetFile]);
  return uniqueStrings([...extractFilesFromQuery(queryOutput), ...selectedFiles, ...relationshipFiles]).slice(0, 20);
}

function countArchitectureNodes(graph: ParsedGraph, selectedIds: Set<string>): number {
  let count = 0;
  for (const nodeId of selectedIds) {
    const node = graph.nodesById.get(nodeId);
    if (node && /\b(router|provider|registry|config|server|tool|engine|mcp|architecture|dependency|module|adapter)\b/i.test(node.label)) {
      count += 1;
    }
  }

  return count;
}

function calculateMetrics(
  analysis: PromptAnalysis,
  graph: ParsedGraph,
  selectedIds: Set<string>,
  relatedFiles: string[],
  affectedModules: string[],
  relationships: RepositoryRelationship[]
): RepositoryComplexityMetrics {
  const relationshipTypes = new Set(relationships.map((relationship) => relationship.relation));
  const crossModuleRelationships = relationships.filter((relationship) => {
    if (!relationship.sourceFile || !relationship.targetFile) {
      return false;
    }

    return moduleFromFile(relationship.sourceFile) !== moduleFromFile(relationship.targetFile);
  });
  const selectedDegrees = [...selectedIds].map((id) => graph.nodesById.get(id)?.degree ?? 0);
  const averageDegree = selectedDegrees.length > 0 ? selectedDegrees.reduce((sum, degree) => sum + degree, 0) / selectedDegrees.length : 0;
  const architectureNodes = countArchitectureNodes(graph, selectedIds);
  const connectedSystemsAffected = affectedModules.length;

  const dependencyComplexity = clamp(
    crossModuleRelationships.length * 9 + relationships.length * 3 + relationshipTypes.size * 6 + Math.min(20, averageDegree * 2)
  );
  const architectureImpact = clamp(
    affectedModules.length * 14 + relatedFiles.length * 3 + architectureNodes * 8 + Math.min(24, averageDegree * 2)
  );
  const reasoningDepthRequired = clamp(
    analysis.reasoningIntensity * 0.35 + architectureImpact * 0.35 + dependencyComplexity * 0.25 + connectedSystemsAffected * 4
  );
  let score = clamp(
    analysis.complexityScore * 0.38 +
      architectureImpact * 0.26 +
      dependencyComplexity * 0.24 +
      Math.min(100, connectedSystemsAffected * 14) * 0.12
  );

  if (analysis.taskType === "coding" && relatedFiles.length <= 1 && affectedModules.length <= 1 && relationships.length <= 2) {
    score = Math.min(score, 38);
  }

  return {
    taskDifficulty: difficultyFromScore(score),
    score,
    reasoningDepthRequired,
    architectureImpact,
    dependencyComplexity,
    connectedSystemsAffected,
    relatedFileCount: relatedFiles.length,
    affectedModuleCount: affectedModules.length
  };
}

function summarizeRelations(relationships: RepositoryRelationship[]): string {
  const counts = new Map<string, number>();
  for (const relationship of relationships) {
    counts.set(relationship.relation, (counts.get(relationship.relation) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([relation, count]) => `${relation} (${count})`)
    .join(", ");
}

function collectArchitectureContext(
  graph: ParsedGraph,
  selectedIds: Set<string>,
  affectedModules: string[],
  relationships: RepositoryRelationship[],
  queryOutput: string
): string[] {
  const centralLabels = graph.centralNodes
    .filter((node) => selectedIds.has(node.id) || /\b(router|provider|config|server|tool|engine|mcp|registry)\b/i.test(node.label))
    .slice(0, 6)
    .map((node) => `${node.label} (degree ${node.degree})`);
  const selectedArchitectureNodes = [...selectedIds]
    .map((id) => graph.nodesById.get(id))
    .filter((node): node is ParsedGraphNode => Boolean(node))
    .filter((node) => /\b(router|provider|registry|config|server|tool|engine|mcp|architecture|dependency|module|adapter)\b/i.test(node.label))
    .slice(0, 8)
    .map((node) => node.label);
  const traversalHeader = queryOutput
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("Traversal:"));

  return uniqueStrings([
    graph.communityCount > 0 ? `Graph communities detected: ${graph.communityCount}` : undefined,
    affectedModules.length > 0 ? `Affected modules: ${affectedModules.join(", ")}` : undefined,
    centralLabels.length > 0 ? `Central related nodes: ${centralLabels.join(", ")}` : undefined,
    selectedArchitectureNodes.length > 0 ? `Architecture nodes: ${selectedArchitectureNodes.join(", ")}` : undefined,
    relationships.length > 0 ? `Relationship mix: ${summarizeRelations(relationships)}` : undefined,
    traversalHeader
  ]);
}

function buildContext(analysis: PromptAnalysis, graph: ParsedGraph, prompt: string, queryOutput: string): GraphifyContext {
  const selectedIds = selectRelevantNodeIds(graph, prompt, queryOutput);
  const dependencyRelationships = collectRelationships(graph, selectedIds);
  const relatedFiles = collectFiles(graph, selectedIds, dependencyRelationships, queryOutput);
  const affectedModules = uniqueStrings(relatedFiles.map(moduleFromFile)).slice(0, 16);
  const architectureContext = collectArchitectureContext(graph, selectedIds, affectedModules, dependencyRelationships, queryOutput);
  const metrics = calculateMetrics(analysis, graph, selectedIds, relatedFiles, affectedModules, dependencyRelationships);
  const signals = [
    "graphify:queried",
    metrics.architectureImpact >= 65 ? "graphify:architecture_impact_high" : undefined,
    metrics.dependencyComplexity >= 65 ? "graphify:dependency_complexity_high" : undefined,
    metrics.relatedFileCount <= 1 && metrics.affectedModuleCount <= 1 ? "graphify:isolated_change" : undefined
  ].filter((signal): signal is string => Boolean(signal));

  return {
    relatedFiles,
    affectedModules,
    dependencyRelationships,
    architectureContext,
    metrics,
    signals
  };
}

export async function analyzeRepositoryWithGraphify(
  input: OptimToolInput,
  analysis: PromptAnalysis
): Promise<RepositoryIntelligence> {
  const repositoryRoot = resolveRepositoryRoot(input);
  const graphPath = resolveGraphPath(input, repositoryRoot);
  const query = buildGraphifyQuestion(input.prompt, analysis);

  if (!shouldUseGraphify(input, analysis)) {
    return baseIntelligence("not_applicable", input, analysis, "Graphify was not needed for this non-codebase request.");
  }

  if (!(await exists(graphPath))) {
    return baseIntelligence(
      "missing_graph",
      input,
      analysis,
      `Graphify graph was not found at ${graphPath}. Run Graphify for this repository to enable persistent routing intelligence.`
    );
  }

  try {
    const [graph, queryResult] = await Promise.all([loadGraph(graphPath), runGraphifyQuery(query, graphPath, repositoryRoot)]);
    const context = buildContext(analysis, graph, input.prompt, queryResult.output);
    const rawQueryContext = queryResult.output.slice(0, maxContextChars);
    const status: RepositoryIntelligence["status"] = queryResult.error ? "query_failed" : "queried";
    const summary =
      status === "queried"
        ? `Graphify found ${context.relatedFiles.length} related file(s), ${context.affectedModules.length} affected module(s), and ${context.dependencyRelationships.length} relationship(s).`
        : `Graphify graph was loaded, but the query command failed: ${queryResult.error}`;

    return {
      provider: "graphify",
      status,
      repositoryRoot,
      graphPath,
      queried: true,
      query,
      summary,
      relatedFiles: context.relatedFiles,
      dependencyRelationships: context.dependencyRelationships,
      affectedModules: context.affectedModules,
      architectureContext: context.architectureContext,
      metrics: context.metrics,
      signals: queryResult.error ? ["graphify:query_failed", ...context.signals] : context.signals,
      ...(rawQueryContext ? { rawQueryContext } : {}),
      ...(queryResult.error ? { error: queryResult.error } : {})
    };
  } catch (error) {
    return baseIntelligence(
      "unavailable",
      input,
      analysis,
      "Graphify repository intelligence could not be loaded.",
      {
        queried: true,
        error: error instanceof Error ? error.message : String(error),
        signals: ["graphify:unavailable"]
      }
    );
  }
}

export function enrichPromptAnalysisWithRepositoryIntelligence(
  analysis: PromptAnalysis,
  repositoryIntelligence: RepositoryIntelligence
): PromptAnalysis {
  if (repositoryIntelligence.status !== "queried" && repositoryIntelligence.status !== "query_failed") {
    return {
      ...analysis,
      repositoryIntelligence,
      signals: uniqueStrings([...analysis.signals, ...repositoryIntelligence.signals])
    };
  }

  const metrics = repositoryIntelligence.metrics;
  const rawComplexityScore = clamp(
    analysis.complexityScore * 0.5 +
      metrics.score * 0.3 +
      metrics.architectureImpact * 0.1 +
      metrics.dependencyComplexity * 0.1
  );
  const graphComplexityFloor =
    metrics.architectureImpact >= 70 || metrics.dependencyComplexity >= 70
      ? 72
      : metrics.architectureImpact >= 50 || metrics.dependencyComplexity >= 50 || metrics.connectedSystemsAffected > 1
        ? 45
        : 0;
  const complexityScore = clamp(Math.max(rawComplexityScore, graphComplexityFloor));
  const reasoningIntensity = clamp(Math.max(analysis.reasoningIntensity, metrics.reasoningDepthRequired));
  const planningDepth = clamp(Math.max(analysis.planningDepth, metrics.architectureImpact));
  const contextRequirement = clamp(Math.max(analysis.contextRequirement, metrics.relatedFileCount * 7 + metrics.connectedSystemsAffected * 10));
  const taskDifficulty = difficultyFromScore(complexityScore);

  return {
    ...analysis,
    complexityScore,
    taskDifficulty,
    reasoningIntensity,
    planningDepth,
    contextRequirement,
    executionPriority: taskDifficulty === "difficult" || metrics.architectureImpact >= 70 ? "quality" : taskDifficulty === "simple" ? "speed" : "balanced",
    requiresLongContext: analysis.requiresLongContext || metrics.relatedFileCount > 10 || metrics.connectedSystemsAffected > 4,
    requiresReasoningModel: analysis.requiresReasoningModel || metrics.reasoningDepthRequired >= 68 || metrics.architectureImpact >= 70,
    repositoryIntelligence,
    signals: uniqueStrings([...analysis.signals, ...repositoryIntelligence.signals])
  };
}

function formatRelationship(relationship: RepositoryRelationship): string {
  const sourceFile = relationship.sourceFile ? ` (${relationship.sourceFile})` : "";
  const targetFile = relationship.targetFile ? ` (${relationship.targetFile})` : "";
  const confidence = relationship.confidence ? ` [${relationship.confidence}]` : "";
  return `${relationship.source}${sourceFile} --${relationship.relation}${confidence}--> ${relationship.target}${targetFile}`;
}

export function buildGraphifyPromptContext(repositoryIntelligence: RepositoryIntelligence | undefined): string | undefined {
  if (!repositoryIntelligence || (repositoryIntelligence.status !== "queried" && repositoryIntelligence.status !== "query_failed")) {
    return undefined;
  }

  const metrics = repositoryIntelligence.metrics;
  const sections = [
    "[GRAPHIFY REPOSITORY INTELLIGENCE]",
    `Source: persistent Graphify graph (${repositoryIntelligence.graphPath})`,
    `Summary: ${repositoryIntelligence.summary}`,
    `Complexity: difficulty=${metrics.taskDifficulty}; score=${metrics.score}/100; reasoning=${metrics.reasoningDepthRequired}/100; architecture=${metrics.architectureImpact}/100; dependencies=${metrics.dependencyComplexity}/100; connected_systems=${metrics.connectedSystemsAffected}`,
    repositoryIntelligence.relatedFiles.length > 0
      ? `Related files:\n${repositoryIntelligence.relatedFiles.slice(0, 12).map((file) => `- ${file}`).join("\n")}`
      : undefined,
    repositoryIntelligence.affectedModules.length > 0
      ? `Affected modules:\n${repositoryIntelligence.affectedModules.slice(0, 10).map((moduleName) => `- ${moduleName}`).join("\n")}`
      : undefined,
    repositoryIntelligence.dependencyRelationships.length > 0
      ? `Dependency relationships:\n${repositoryIntelligence.dependencyRelationships
          .slice(0, 10)
          .map((relationship) => `- ${formatRelationship(relationship)}`)
          .join("\n")}`
      : undefined,
    repositoryIntelligence.architectureContext.length > 0
      ? `Architecture context:\n${repositoryIntelligence.architectureContext.slice(0, 8).map((context) => `- ${context}`).join("\n")}`
      : undefined,
    repositoryIntelligence.rawQueryContext ? `Graph traversal excerpt:\n${repositoryIntelligence.rawQueryContext}` : undefined,
    "[/GRAPHIFY REPOSITORY INTELLIGENCE]"
  ].filter((section): section is string => Boolean(section));

  return sections.join("\n");
}

export function prependGraphifyContext(prompt: string, repositoryIntelligence: RepositoryIntelligence | undefined): string {
  const context = buildGraphifyPromptContext(repositoryIntelligence);
  if (!context) {
    return prompt;
  }

  return `${context}\n\n[USER REQUEST]\n${prompt}`;
}
