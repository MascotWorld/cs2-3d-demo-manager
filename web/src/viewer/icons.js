import { weaponNameToModelKey } from './math.js';

let hudAssets = new Set();

export function configureHudAssets(files = []) {
  hudAssets = new Set(files);
  const faces = [
    ['CS2 HUD', 400, 'stratum2-regular.otf'],
    ['CS2 HUD', 500, 'stratum2-medium.otf'],
    ['CS2 HUD', 700, 'stratum2-bold.otf'],
    ['CS2 HUD Digits', 400, 'stratum2regular_monodigit.ttf'],
    ['CS2 HUD Digits', 700, 'stratum2bold_monodigit.ttf'],
  ];
  let style = document.getElementById('local-hud-fonts');
  if (!style) {
    style = document.createElement('style');
    style.id = 'local-hud-fonts';
    document.head.append(style);
  }
  const rules = faces.filter(([, , file]) => hudAssets.has(`fonts/${file}`)).map(([family, weight, file]) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('/api/assets/hud/fonts/${file}');}`
  ).join('');
  if (style.textContent !== rules) style.textContent = rules;
}

function nativeIcon(path, className, label = '') {
  if (!hudAssets.has(path)) return '';
  return `<img class="${className}" src="/api/assets/hud/${path}" alt="${label}"${label ? ` title="${label}"` : ' aria-hidden="true"'} draggable="false">`;
}

const equipmentAliases = {
  glock18: 'glock', m4a4: 'm4a1', incendiarygrenade: 'incgrenade', knife_ct: 'knife',
  butterflyknife: 'knife_butterfly', karambit: 'knife_karambit', m9bayonet: 'knife_m9_bayonet',
  kukriknife: 'knife_kukri', stiletto: 'knife_stiletto', ursusknife: 'knife_ursus',
  dualberettas: 'elite', zeusx27: 'taser', ak: 'ak47', hegrenade: 'hegrenade',
};

export function weaponSvgIcon(weaponName = '', className = 'w-icon') {
  const w = String(weaponName || '').toLowerCase();
  const slug = w.replace(/^weapon_/, '').replace(/[^a-z0-9_]/g, '');
  const modelKey = weaponNameToModelKey(w);
  const exact = equipmentAliases[slug] || slug;
  const weapon = nativeIcon(`equipment/${exact}.svg`, className) ||
    nativeIcon(`equipment/${equipmentAliases[modelKey] || modelKey}.svg`, className);
  if (weapon) return weapon;

  // C4
  if (w.includes('c4')) {
    return `<svg class="${className}" viewBox="0 0 36 16" fill="currentColor" aria-hidden="true"><rect x="7" y="2" width="22" height="12" rx="1.5" opacity="0.9"/><rect x="11" y="4" width="9" height="4" fill="#0f172a"/><rect x="22" y="4" width="4" height="4" opacity="0.65"/><path d="M9 10h18v1.5H9z" opacity="0.55"/></svg>`;
  }
  // Knife / Zeus
  if (w.includes('knife') || w.includes('bayonet') || w.includes('karambit') || w.includes('kukri') || w.includes('stiletto') || w.includes('talon') || w.includes('ursus') || w.includes('dagger')) {
    return `<svg class="${className}" viewBox="0 0 36 16" fill="currentColor" aria-hidden="true"><path d="M4 11l6-1.5 2-2.2 18-3.8c-1.8 3.6-6.2 6.2-13.5 6.8l-3 1.4-2.4-.5L5.2 13z"/></svg>`;
  }
  // Grenades
  if (w.includes('smoke')) {
    return `<svg class="${className}" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="6" height="11" rx="1.2"/><rect x="7" y="2" width="4" height="2"/><path d="M12 4h2.5v5H13z" opacity="0.75"/></svg>`;
  }
  if (w.includes('flash')) {
    return `<svg class="${className}" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><rect x="6.5" y="4.5" width="5" height="10" rx="1.5"/><rect x="7" y="2" width="4" height="2.2"/><path d="M5 7h8v1.3H5zm0 3h8v1.3H5z" opacity="0.35"/></svg>`;
  }
  if (w.includes('he grenade') || w === 'hegrenade') {
    return `<svg class="${className}" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><ellipse cx="9" cy="10" rx="4.5" ry="5.2"/><rect x="7.5" y="2.5" width="3" height="2.4"/><path d="M10.5 3.5l3 1.5-0.8 2.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
  }
  if (w.includes('molotov') || w.includes('incendiary')) {
    return `<svg class="${className}" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><path d="M7 6h4l1 3.2v5.8H6V9.2z"/><path d="M8 3.2h2V6H8z"/><path d="M9.5 1c1 1.2 1.8 2.1.5 3.1-1.1-.6-1.3-1.8-.5-3.1z"/></svg>`;
  }
  if (w.includes('decoy')) {
    return `<svg class="${className}" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><rect x="7" y="4.5" width="4" height="10.5" rx="1.5"/><rect x="7.5" y="2.2" width="3" height="2"/></svg>`;
  }
  // AWP / Sniper
  if (w.includes('awp') || w.includes('ssg') || w.includes('scar') || w.includes('g3sg1')) {
    return `<svg class="${className}" viewBox="0 0 46 16" fill="currentColor" aria-hidden="true"><path d="M2 10.5l7.5-1.2 2-1.8h7V5.2h9.5l.6 1.8h15v1.6h-15l-2.5 1.8H21l-1.5 3.2H17l.6-2.8H12l-2.8 2.6-6.2.8z"/><rect x="15" y="2.5" width="11" height="2.1" rx="0.8"/></svg>`;
  }
  // AK-47 / Galil
  if (w.includes('ak') || w.includes('galil')) {
    return `<svg class="${className}" viewBox="0 0 42 16" fill="currentColor" aria-hidden="true"><path d="M2 9.5l7.2-1.2 2-1.8h13.5l2.2-1.2h2.2l-.4 1.6H39v1.5H27.2l-1.8 1.4h-4.8l1.2 4.4-2.8.4-1.5-4.4H14l-1.5 3.6H10l.9-3.6H7.8L2.8 12.8z"/></svg>`;
  }
  // M4A1-S / M4A4 / AUG / SG / FAMAS
  if (w.includes('m4') || w.includes('aug') || w.includes('sg') || w.includes('famas')) {
    const hasSilencer = w.includes('m4a1');
    return `<svg class="${className}" viewBox="0 0 42 16" fill="currentColor" aria-hidden="true"><path d="M2 9.2h7.5l1.5-2h11.5l1.5-1.3h1.6v1.4h8.2${hasSilencer ? 'l.4-.5h5.8v2.2h-5.8l-.4-.5' : 'h4.8v1.3'}H26.2l-1.6 1.2h-4.5l-.2 3.8h-2.4l.1-3.8h-4.2l-1.3 3.2H9.8l.9-3.2H6.5L2.5 12z"/><rect x="14.5" y="4.5" width="6" height="1.8" rx="0.5"/></svg>`;
  }
  // SMG / Shotgun
  if (w.includes('mp') || w.includes('mac') || w.includes('ump') || w.includes('p90') || w.includes('bizon') || w.includes('nova') || w.includes('xm') || w.includes('mag') || w.includes('sawed')) {
    return `<svg class="${className}" viewBox="0 0 38 16" fill="currentColor" aria-hidden="true"><path d="M4 8.5h6l1.5-2h13.5v1.6h8.5v1.4h-8.5l-1.5 1.3h-4.5l-.4 4.2h-2.3l.3-4.2H12l-1.4 3.4H8.2l1-3.4H4.5z"/></svg>`;
  }
  // Pistols
  if (w.includes('deagle') || w.includes('glock') || w.includes('usp') || w.includes('p2000') || w.includes('p250') || w.includes('tec') || w.includes('five') || w.includes('cz75') || w.includes('revolver') || w.includes('berettas')) {
    return `<svg class="${className}" viewBox="0 0 26 16" fill="currentColor" aria-hidden="true"><path d="M4 5.2h16.5v2.6H12l-1.2 1.4 1.6 4.8H8.6L7.4 9.5H5.8L4.8 11H3.6V6.2z"/></svg>`;
  }
  // Fallback rifle
  return `<svg class="${className}" viewBox="0 0 40 16" fill="currentColor" aria-hidden="true"><path d="M3 9h34v2H22l-1.2 3.5h-2.3L19.4 11H12l-1.4 3H8.3l1.1-3H3z"/></svg>`;
}

export function hpCrossIcon(className = 'hud-ico') {
  return nativeIcon('hud/health_cross.svg', className) || `<svg class="${className}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.2 2h3.6v4.2H14v3.6H9.8V14H6.2V9.8H2V6.2h4.2z"/></svg>`;
}

export function armorIcon(hasHelmet = false, className = 'hud-ico') {
  const icon = nativeIcon(hasHelmet ? 'hud/armor_helmet.svg' : 'hud/armor.svg', className);
  if (icon) return icon;
  if (hasHelmet) {
    return `<svg class="${className}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5L3 3.4v4.3c0 3.2 2.1 5.8 5 6.8 2.9-1 5-3.6 5-6.8V3.4L8 1.5zm0 2.1a2.1 2.1 0 0 1 2.1 2.1v.9H5.9v-.9A2.1 2.1 0 0 1 8 3.6z"/></svg>`;
  }
  return `<svg class="${className}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2L3 3.8v4c0 3 2.1 5.5 5 6.4 2.9-.9 5-3.4 5-6.4v-4L8 2z"/></svg>`;
}

export function defuseKitIcon(className = 'hud-ico') {
  return nativeIcon('equipment/defuser.svg', className) || `<svg class="${className}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.6 2.1a3.2 3.2 0 0 0-3.7 4.4L3 11.4l1.6 1.6 4.9-4.9a3.2 3.2 0 0 0 4.4-3.7l-1.8 1.8-1.5-1.5 1.8-1.8z"/></svg>`;
}

export function skullIcon(className = 'hud-ico') {
  return `<svg class="${className}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5c-3.1 0-5.4 2.1-5.4 4.9 0 1.6.7 2.8 1.8 3.6v2.5h7.2V10c1.1-.8 1.8-2 1.8-3.6 0-2.8-2.3-4.9-5.4-4.9zm-1.9 6a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2zm3.8 0a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2z"/></svg>`;
}

const deathNotices = {
  headshot: ['Headshot', '<circle cx="8" cy="8" r="4.8"/><path d="M8 1v4m0 6v4M1 8h4m6 0h4"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/>'],
  wallbang: ['Wall penetration', '<path d="M7 2.5v3l2 2.5-2 2.5v3M2 8h4m4 0h4m-2-2 2 2-2 2"/>'],
  smoke: ['Through smoke', '<path d="M4 12a2.5 2.5 0 0 1-1-4.8 3.2 3.2 0 0 1 6-1.6A2.8 2.8 0 0 1 12 8a2 2 0 0 1 0 4zM5 9h6"/>'],
  noscope: ['No scope', '<circle cx="8" cy="8" r="5"/><path d="M8 4v8M4 8h8M2 14 14 2"/>'],
  blind: ['Attacker blinded', '<path d="M1.7 8S4 4.2 8 4.2 14.3 8 14.3 8 12 11.8 8 11.8 1.7 8 1.7 8ZM2 14 14 2"/><circle cx="8" cy="8" r="1.8"/>'],
  'flash-assist': ['Flash assist', '<path d="M8 1.5v3m0 7v3m-6.5-6.5h3m7 0h3M3.4 3.4l2.1 2.1m5 5 2.1 2.1m0-9.2-2.1 2.1m-5 5-2.1 2.1"/><circle cx="8" cy="8" r="2"/>'],
};

const nativeDeathNotices = {
  headshot: 'deathnotice/icon_headshot.svg', wallbang: 'deathnotice/penetrate.svg',
  smoke: 'deathnotice/smoke_kill.svg', noscope: 'deathnotice/noscope.svg',
  blind: 'deathnotice/blind_kill.svg', 'flash-assist': 'equipment/flashbang_assist.svg',
};

export function deathNoticeIcon(kind, className = 'kf-mod-icon') {
  const [label, geometry] = deathNotices[kind];
  return nativeIcon(nativeDeathNotices[kind], className, label) || `<svg class="${className}" role="img" aria-label="${label}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><title>${label}</title>${geometry}</svg>`;
}
