import { NavLink } from 'react-router-dom'

const items = [
  { to: '/', label: '下载' },
  { to: '/batch', label: '批量' },
  { to: '/history', label: '历史' },
  { to: '/settings', label: '设置' },
]

export default function Sidebar() {
  return (
    <nav className="w-44 flex-shrink-0 border-r border-slate-200 bg-white">
      <div className="px-4 py-4 text-lg font-semibold">DouyinDownloader</div>
      <ul className="space-y-1 px-2">
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              end={it.to === '/'}
              className={({ isActive }) =>
                'block rounded-md px-3 py-2 text-sm ' +
                (isActive
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100')
              }
            >
              {it.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
