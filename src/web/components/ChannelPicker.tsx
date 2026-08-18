import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { ProviderDefinition, ProviderId } from '../../shared/types';
import { Modal, IconButton } from './ui';
import { ProviderIcon } from './ProviderIcon';

const CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'chat', label: '聊天协作' },
  { id: 'push', label: '移动推送' },
  { id: 'email', label: '邮件' },
  { id: 'sms', label: '短信' },
  { id: 'universal', label: '通用' }
] as const;

/**
 * 渠道选择弹框：替代原来的 <select> 下拉。
 * 搜索 + 分类 tab + 品牌图标网格，键盘可导航（↑↓/Enter/Esc）。
 */
export function ChannelPicker({
  providers, current, onPick, onClose
}: {
  providers: ProviderDefinition[];
  current?: ProviderId;
  onPick: (provider: ProviderId) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<typeof CATEGORIES[number]['id']>('all');
  const listRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter((p) => {
      const matchCat = category === 'all' || p.category === category;
      const matchQuery = !q || `${p.name} ${p.id} ${p.description}`.toLowerCase().includes(q);
      return matchCat && matchQuery;
    });
  }, [providers, query, category]);

  useEffect(() => { setActiveIndex(0); }, [query, category]);

  // 键盘导航
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!filtered.length) return;
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!filtered.length) return;
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      // 无匹配项时也要拦截：picker 渲染在 ChannelForm 的 <form> 里，放过 Enter 会隐式提交表单
      event.preventDefault();
      if (filtered[activeIndex]) onPick(filtered[activeIndex].id);
    }
  };

  // 滚动激活项进入视图
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <Modal title="选择推送渠道" onClose={onClose} wide>
      <div className="picker" onKeyDown={onKeyDown}>
        <div className="picker-search">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索渠道名称或类型…"
            aria-label="搜索渠道"
          />
          {query && <IconButton label="清除" icon={X} onClick={() => setQuery('')} />}
        </div>
        <div className="picker-cats" role="tablist" aria-label="渠道分类">
          {CATEGORIES.map((cat) => {
            const count = cat.id === 'all'
              ? providers.length
              : providers.filter((p) => p.category === cat.id).length;
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={category === cat.id}
                className={category === cat.id ? 'active' : ''}
                onClick={() => setCategory(cat.id)}
                disabled={count === 0}
              >
                {cat.label}<i>{count}</i>
              </button>
            );
          })}
        </div>
        <div className="picker-grid" ref={listRef}>
          {filtered.map((provider, index) => (
            <button
              key={provider.id}
              type="button"
              data-idx={index}
              className={[
                'picker-tile',
                index === activeIndex ? 'focused' : '',
                provider.id === current ? 'current' : ''
              ].join(' ')}
              onClick={() => onPick(provider.id)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <ProviderIcon provider={provider.id} name={provider.name} size={30} />
              <span className="picker-tile-name">
                <strong>{provider.name}</strong>
                <small>{provider.support === 'gateway' ? '兼容网关' : provider.support === 'custom' ? '自定义' : '原生直连'} · {provider.description}</small>
              </span>
              {provider.id === current && <span className="picker-current">当前</span>}
            </button>
          ))}
          {!filtered.length && (
            <div className="picker-empty">
              <span>没有匹配的渠道。{query && <>试试调整搜索词“<code>{query}</code>”。</>}</span>
            </div>
          )}
        </div>
        <div className="picker-footer">
          <span>{filtered.length} 个渠道</span>
          <small>↑↓ 选择 · Enter 确认 · Esc 关闭</small>
        </div>
      </div>
    </Modal>
  );
}

