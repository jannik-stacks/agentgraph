export type NodeKind = 'trigger' | 'job' | 'persona'
export type Mode = 'shadow' | 'warn' | 'block'
export type EdgeKind = 'needs' | 'triggers' | 'persona'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  workflow?: string
  mode?: Mode
  persona?: string
  uses?: string
  on?: string[]
  needs?: string[]
  matrix?: Record<string, string[]>
  environment?: { name: string; reviewers: string[] }
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

type JobSpec = Omit<GraphNode, 'id' | 'kind' | 'label'>

const triggers = ['pull_request', 'issue_comment', 'tool_call', 'stop']
const personas = ['watcher', 'maintainer', 'implementor']

const guardJobs: Record<string, JobSpec> = {
  changed: { on: ['pull_request'], mode: 'block', uses: 'bothub/changed-files@v1' },
  lint: { needs: ['changed'], mode: 'block', uses: 'bothub/lint@v1' },
  'comment-ratio': { needs: ['changed'], mode: 'warn', uses: 'bothub/comment-ratio@v1' },
  'chunk-rules': {
    needs: ['changed'],
    mode: 'shadow',
    uses: 'bothub/rules@v1',
    matrix: { chunk: ['types', 'naming', 'docs', 'tests'] },
  },
  watcher: { on: ['tool_call', 'stop'], mode: 'warn', persona: 'watcher' },
  maintainer: { on: ['issue_comment'], mode: 'warn', persona: 'maintainer' },
  ship: {
    needs: ['lint', 'chunk-rules'],
    mode: 'block',
    persona: 'implementor',
    uses: 'bothub/ship@v1',
    environment: { name: 'production', reviewers: ['morgan'] },
  },
}

const triggerId = (name: string) => `on:${name}`
const personaId = (name: string) => `persona:${name}`

export function buildGraph(workflow: string, jobs: Record<string, JobSpec>, triggerNames: string[], personaNames: string[]): Graph {
  const nodes: GraphNode[] = [
    ...triggerNames.map((name): GraphNode => ({ id: triggerId(name), kind: 'trigger', label: name })),
    ...Object.entries(jobs).map(([id, spec]): GraphNode => ({ id, kind: 'job', label: id, workflow, ...spec })),
    ...personaNames.map((name): GraphNode => ({ id: personaId(name), kind: 'persona', label: name })),
  ]
  const edges = Object.entries(jobs).flatMap(([id, spec]) => [
    ...(spec.on ?? []).map((t): GraphEdge => ({ id: `${t}->${id}`, source: triggerId(t), target: id, kind: 'triggers' })),
    ...(spec.needs ?? []).map((n): GraphEdge => ({ id: `${n}->${id}`, source: n, target: id, kind: 'needs' })),
    ...(spec.persona ? [{ id: `${id}->persona`, source: id, target: personaId(spec.persona), kind: 'persona' } as GraphEdge] : []),
  ])
  return { nodes, edges }
}

export const small = buildGraph('guard', guardJobs, triggers, personas)

function generated(jobCount: number, layers: number): Graph {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!
  const modes: Mode[] = ['shadow', 'warn', 'block']
  const bigPersonas = [...personas, 'reviewer', 'release', 'triage']
  const perLayer = Math.ceil(jobCount / layers)
  const jobs: Record<string, JobSpec> = {}
  const byLayer: string[][] = []
  for (let i = 0; i < jobCount; i++) {
    const layer = Math.floor(i / perLayer)
    const id = `job-${String(i).padStart(2, '0')}`
    const prev = byLayer[layer - 1]
    const needs = prev ? [...new Set([pick(prev), ...(rand() < 0.4 ? [pick(prev)] : [])])] : undefined
    jobs[id] = {
      workflow: `wf-${layer % 3}`,
      mode: pick(modes),
      uses: `bothub/step-${i % 9}@v1`,
      ...(needs ? { needs } : { on: [pick(triggers)] }),
      ...(rand() < 0.15 ? { persona: pick(bigPersonas) } : {}),
    }
    ;(byLayer[layer] ??= []).push(id)
  }
  return buildGraph('generated', jobs, triggers, bigPersonas)
}

export const big = generated(60, 8)

export const datasets = { small, big } as const
export type DatasetKey = keyof typeof datasets
