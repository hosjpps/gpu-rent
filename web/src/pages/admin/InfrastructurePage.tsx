import { useInfrastructure, useSetNodeStatus, useToggleGpu } from '../../api/hooks';
import type { InfraGpu, InfraNode } from '../../api/types';
import { ErrorNote } from '../../components/ErrorNote';
import { QueryState } from '../../components/ui';
import { NODE_STATUS_LABEL } from '../../lib/format';

export default function InfrastructurePage() {
  const infra = useInfrastructure();
  return (
    <>
      <QueryState isLoading={infra.isLoading} error={infra.error} onRetry={() => void infra.refetch()} />
      {infra.data?.map((dc) => (
        <section key={dc.code} className="card section">
          <h2>
            {dc.name} <span className="code-chip mono">{dc.code}</span>
          </h2>
          {dc.nodes.map((node) => (
            <NodeBlock key={node.id} node={node} />
          ))}
        </section>
      ))}
    </>
  );
}

function NodeBlock({ node }: { node: InfraNode }) {
  const setStatus = useSetNodeStatus();
  const enabled = node.gpus.filter((g) => g.isEnabled).length;
  return (
    <details className="node">
      <summary>
        <span className="mono">{node.hostname}</span>
        <span className={`badge badge-node-${node.status}`}>{NODE_STATUS_LABEL[node.status] ?? node.status}</span>
        <span className="muted small">
          {node.cpuCores} CPU · {node.ramGb} ГБ RAM · GPU включено {enabled} из {node.gpus.length}
        </span>
      </summary>
      <div className="node-body">
        <label className="inline-field">
          Статус ноды
          <select
            value={node.status}
            disabled={setStatus.isPending}
            onChange={(e) => setStatus.mutate({ id: node.id, status: e.target.value })}
            aria-label={`Статус ноды ${node.hostname}`}
          >
            {Object.entries(NODE_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <ErrorNote error={setStatus.error} />
        <ul className="gpu-list">
          {node.gpus.map((g) => (
            <GpuItem key={g.id} gpu={g} />
          ))}
        </ul>
      </div>
    </details>
  );
}

function GpuItem({ gpu }: { gpu: InfraGpu }) {
  const toggle = useToggleGpu();
  return (
    <li className={gpu.isEnabled ? 'gpu-item' : 'gpu-item off'}>
      <div>
        <strong>{gpu.model}</strong> <span className="muted small nowrap">слот {gpu.slot}</span>
        <div className="muted small mono">{gpu.serial}</div>
        {gpu.busy && <span className="badge badge-running">занята</span>}
      </div>
      <button
        type="button"
        className={gpu.isEnabled ? 'btn btn-sm btn-danger-outline' : 'btn btn-sm'}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate({ id: gpu.id, enable: !gpu.isEnabled })}
        aria-label={`${gpu.isEnabled ? 'Выключить' : 'Включить'} GPU ${gpu.serial}`}
      >
        {gpu.isEnabled ? 'Выключить' : 'Включить'}
      </button>
      {toggle.error && <ErrorNote error={toggle.error} />}
    </li>
  );
}
