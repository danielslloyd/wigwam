// The grown-ups' page, part 2: kids' devices, co-parents, friends, a connected YouTube
// account's inbox, and recent changes. These save straight away (no Publish needed),
// except adding something to the lists, which goes into the Publish bar like any approval.

import { sb, state, change, toast, kidChip, dirty, must, allRows } from './admin.js';
import { esc, timeAgo, thumbUrl } from './shared.js';
import { GOOGLE_CLIENT_ID } from './config.js';

const el = (id) => document.getElementById(id);
const uid = () => state.user.id;
const adminUrl = () => location.origin + location.pathname;
const social = {
  devices: [], members: [], memberInvites: [], friends: [], friendWigwams: [], friendInvites: [],
  accounts: [], inbox: [], activity: [],
  friendView: null,      // { wigwam, name, owner, sources } being looked at
  inboxTab: 'channel', inboxShown: 30, newLink: null,
};

async function invoke(name, body) {
  const { data, error } = await sb.functions.invoke(name, body ? { body } : undefined);
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return data;
}

export async function refreshSocial() {
  await Promise.all([loadDevices(), loadMembers(), loadFriends(), loadYouTube(), loadActivity()].map((p) => p.catch((e) => console.warn(e))));
  renderSocial();
}

export function renderSocial() {
  if (!state.wigwam) return;
  renderYouTube(); renderDevices(); renderFriends(); renderMembers(); renderActivity();
}

// ---------------------------------------------------------------- devices

async function loadDevices() {
  social.devices = await must(sb.from('devices').select('user_id, name, created_at').eq('wigwam_id', state.wigwam).order('created_at'));
}

function renderDevices() {
  el('devices').innerHTML = (social.devices.length ? social.devices.map((d) => `
    <div class="row">
      <span class="row-icon">📱</span>
      <div class="row-text"><b>${esc(d.name)}</b><div class="muted">Added ${esc(timeAgo(d.created_at))}</div></div>
      <button type="button" class="btn small" data-device-rename="${esc(d.user_id)}">Rename</button>
      <button type="button" class="btn small danger" data-device-remove="${esc(d.user_id)}">Remove</button>
    </div>`).join('') : '<p class="muted empty">No devices yet.</p>');
  el('devices-count').textContent = social.devices.length;
}

el('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = el('pair-code').value.replace(/\s/g, '').toUpperCase();
  if (code.length < 6) return toast('Type the 6-letter code the tablet shows.');
  const btn = e.submitter; btn.disabled = true;
  try {
    const name = await must(sb.rpc('claim_device', { pair_code: code, wigwam: state.wigwam, device_name: el('pair-name').value }));
    el('pair-code').value = ''; el('pair-name').value = '';
    toast(`✓ ${name} is set up. It shows the kids in a few seconds.`);
    await Promise.all([loadDevices(), loadActivity()]); renderSocial();
  } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
});

el('devices').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = social.devices.find((x) => x.user_id === (t.dataset.deviceRename || t.dataset.deviceRemove));
  if (!d) return;
  try {
    if (t.dataset.deviceRename) {
      const name = prompt('Name this device', d.name)?.trim();
      if (!name) return;
      await must(sb.from('devices').update({ name }).eq('user_id', d.user_id));
    } else {
      if (!confirm(`Remove ${d.name}? It goes back to showing a pairing code.`)) return;
      await must(sb.from('devices').delete().eq('user_id', d.user_id));
      await must(sb.from('activity').insert({ wigwam_id: state.wigwam, user_id: uid(), message: `removed the device ${d.name}` }));
    }
    await Promise.all([loadDevices(), loadActivity()]); renderSocial();
  } catch (err) { toast(err.message, 'error'); }
});

// ---------------------------------------------------------------- grown-ups in this wigwam

async function loadMembers() {
  social.members = await must(sb.from('members').select('user_id, role, created_at, profiles(name, email, avatar)').eq('wigwam_id', state.wigwam).order('created_at'));
  social.memberInvites = await must(sb.from('invites').select('token, role, created_at, expires_at').eq('kind', 'member').eq('wigwam_id', state.wigwam).order('created_at'));
}

const myRole = () => social.members.find((m) => m.user_id === uid())?.role;
const face = (p) => p?.avatar ? `<img class="face" src="${esc(p.avatar)}" alt="" referrerpolicy="no-referrer">` : `<span class="face">${esc((p?.name || '?')[0].toUpperCase())}</span>`;

function inviteLink(token) { return `${adminUrl()}#invite=${token}`; }
function linkBox(token, what) {
  return `<div class="linkbox">
    <input readonly value="${esc(inviteLink(token))}" aria-label="Invite link">
    <button type="button" class="btn small" data-copy="${esc(token)}">Copy</button>
    ${navigator.share ? `<button type="button" class="btn small" data-share="${esc(token)}" data-what="${esc(what)}">Share</button>` : ''}
    <button type="button" class="btn small danger" data-cancel-invite="${esc(token)}" aria-label="Cancel this invite">✕</button>
  </div>`;
}

function renderMembers() {
  const owner = myRole() === 'owner';
  const owners = social.members.filter((m) => m.role === 'owner').length;
  el('members').innerHTML = social.members.map((m) => {
    const me = m.user_id === uid();
    return `<div class="row">
      ${face(m.profiles)}
      <div class="row-text"><b>${esc(m.profiles?.name || 'Someone')}${me ? ' (you)' : ''}</b><div class="muted">${esc(m.profiles?.email || '')} · ${m.role === 'owner' ? 'Owner' : 'Can change the lists'}</div></div>
      ${owner && !me ? `<button type="button" class="btn small" data-role="${esc(m.user_id)}">${m.role === 'owner' ? 'Make editor' : 'Make owner'}</button>` : ''}
      ${owner && !me ? `<button type="button" class="btn small danger" data-member-remove="${esc(m.user_id)}">Remove</button>` : ''}
      ${me && (m.role !== 'owner' || owners > 1) && social.members.length > 1 ? '<button type="button" class="btn small danger" data-leave>Leave</button>' : ''}
    </div>`;
  }).join('');
  el('member-invites').innerHTML = !owner ? '<p class="muted">Only an owner can invite grown-ups.</p>' : `
    ${social.memberInvites.map((i) => linkBox(i.token, 'member')).join('')}
    ${social.memberInvites.length ? `<p class="muted small">Send the link to the other grown-up. It works once, for 14 days. They sign in with Google and can then change the lists too.</p>` : ''}
    <button type="button" class="btn" id="invite-member">＋ Invite a grown-up</button>`;
  el('members-count').textContent = social.members.length;
}

async function makeInvite(kind) {
  const row = await must(sb.from('invites').insert({ kind, wigwam_id: kind === 'member' ? state.wigwam : null, created_by: uid() }).select('token').single());
  await copy(inviteLink(row.token), 'Invite link copied. Send it to them.');
  return row.token;
}
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Copy the link from the box.'); }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t || !t.closest('#people-card, #friends-card')) return;
  try {
    if (t.id === 'invite-member') { await makeInvite('member'); await loadMembers(); }
    else if (t.id === 'invite-friend') { await makeInvite('friend'); await loadFriends(); }
    else if (t.dataset.copy) await copy(inviteLink(t.dataset.copy), 'Invite link copied.');
    else if (t.dataset.share) {
      const friend = t.dataset.what === 'friend';
      await navigator.share({ title: 'Wigwam', text: friend ? 'Be my friend on Wigwam, so we can see each other\'s approved channels.' : 'Help me run our Wigwam (the kids\' video list).', url: inviteLink(t.dataset.share) }).catch(() => {});
      return;
    } else if (t.dataset.cancelInvite) { await must(sb.from('invites').delete().eq('token', t.dataset.cancelInvite)); await Promise.all([loadMembers(), loadFriends()]); }
    else if (t.dataset.role) {
      const m = social.members.find((x) => x.user_id === t.dataset.role);
      await must(sb.from('members').update({ role: m.role === 'owner' ? 'editor' : 'owner' }).eq('wigwam_id', state.wigwam).eq('user_id', m.user_id));
      await loadMembers();
    } else if (t.dataset.memberRemove) {
      const m = social.members.find((x) => x.user_id === t.dataset.memberRemove);
      if (!confirm(`Remove ${m.profiles?.name || 'them'} from this wigwam? They won't be able to see or change it any more.`)) return;
      await must(sb.from('members').delete().eq('wigwam_id', state.wigwam).eq('user_id', m.user_id));
      await must(sb.from('activity').insert({ wigwam_id: state.wigwam, user_id: uid(), message: `removed ${m.profiles?.name || 'a grown-up'}` }));
      await Promise.all([loadMembers(), loadActivity()]);
    } else if ('leave' in t.dataset) {
      if (!confirm('Leave this wigwam? You won\'t be able to see or change it any more.')) return;
      await must(sb.from('activity').insert({ wigwam_id: state.wigwam, user_id: uid(), message: 'left this wigwam' }));
      await must(sb.from('members').delete().eq('wigwam_id', state.wigwam).eq('user_id', uid()));
      localStorage.removeItem('tb-admin:wigwam');
      return location.reload();
    } else if (t.dataset.unfriend) {
      const f = social.friends.find((x) => x.id === t.dataset.unfriend);
      if (!confirm(`Stop being friends with ${f?.name || 'them'}?`)) return;
      const [a, b] = [uid(), f.id].sort();
      await must(sb.from('friendships').delete().eq('a', a).eq('b', b));
      social.friendView = null;
      await loadFriends();
    } else if (t.dataset.look) {
      const fw = social.friendWigwams.find((x) => x.wigwam_id === t.dataset.look);
      const sources = await must(sb.from('sources').select('kind, yt_id, handle, title, thumb').eq('wigwam_id', fw.wigwam_id).in('kind', ['channel', 'playlist']).order('position'));
      social.friendView = social.friendView?.wigwam === fw.wigwam_id ? null : { wigwam: fw.wigwam_id, name: fw.wigwams.name, owner: fw.ownerName, sources };
    } else if (t.dataset.friendAdd) {
      const s = social.friendView.sources[+t.dataset.friendAdd];
      addToLists(s.kind, s.yt_id, s.title, `from ${social.friendView.owner}'s wigwam`);
    } else if (t.id === 'share-toggle') {
      const on = t.getAttribute('aria-checked') !== 'true';
      await must(sb.from('wigwams').update({ share_with_friends: on }).eq('id', state.wigwam));
      state.wigwams.find((w) => w.id === state.wigwam).share_with_friends = on;
      await must(sb.from('activity').insert({ wigwam_id: state.wigwam, user_id: uid(), message: on ? 'started sharing this wigwam\'s channels with friends' : 'stopped sharing with friends' }));
      await loadActivity();
    } else return;
    renderSocial();
  } catch (err) { toast(err.message, 'error'); }
});

// ---------------------------------------------------------------- friends

async function loadFriends() {
  const rows = await must(sb.from('friendships').select('a, b'));
  const ids = rows.map((r) => (r.a === uid() ? r.b : r.a));
  social.friends = ids.length ? await must(sb.from('profiles').select('id, name, email, avatar').in('id', ids)) : [];
  // Their wigwams that share with friends (others aren't visible at all)
  const mine = new Set(state.wigwams.map((w) => w.id));
  social.friendWigwams = ids.length
    ? (await must(sb.from('members').select('user_id, wigwam_id, wigwams(name)').in('user_id', ids)))
      .filter((m) => m.wigwams && !mine.has(m.wigwam_id))
      .map((m) => ({ ...m, ownerName: social.friends.find((f) => f.id === m.user_id)?.name || 'A friend' }))
    : [];
  social.friendInvites = await must(sb.from('invites').select('token, created_at').eq('kind', 'friend').eq('created_by', uid()).order('created_at'));
}

function inLists(kind, ytId) {
  const list = { channel: state.wl.channels, playlist: state.wl.playlists, video: state.wl.videos }[kind];
  return list.some((e) => e.id === ytId);
}

/** Adds a channel, playlist or video to the working lists, for the kids ticked under "New things go to". */
function addToLists(kind, ytId, title, where) {
  if (inLists(kind, ytId)) return toast('Already in your lists.');
  const kids = state.wl.profiles.map((p) => p.id).filter((id) => state.addKids.has(id));
  const entry = { id: ytId, ...(title && { title }), profiles: kids };
  ({ channel: state.wl.channels, playlist: state.wl.playlists, video: state.wl.videos })[kind].push(entry);
  if (kind === 'video') state.wl.blocked = state.wl.blocked.filter((id) => id !== ytId);
  toast(`Added “${title || ytId}”${kids.length ? '' : ' (no kids ticked yet)'}. Publish when you're ready.`);
  change(`add ${kind} ${title || ytId} ${where}`);
}

function renderFriends() {
  const w = state.wigwams.find((x) => x.id === state.wigwam);
  el('share-toggle').setAttribute('aria-checked', String(!!w?.share_with_friends));
  el('share-state').textContent = w?.share_with_friends ? 'Shared' : 'Private';
  const byFriend = (f) => social.friendWigwams.filter((m) => m.user_id === f.id);
  el('friends').innerHTML = social.friends.length ? social.friends.map((f) => `
    <div class="row">
      ${face(f)}
      <div class="row-text"><b>${esc(f.name || 'A friend')}</b><div class="muted">${byFriend(f).length ? '' : 'Isn\'t sharing a wigwam with friends'}</div></div>
      ${byFriend(f).map((m) => `<button type="button" class="btn small ${social.friendView?.wigwam === m.wigwam_id ? 'on' : ''}" data-look="${esc(m.wigwam_id)}">🛖 ${esc(m.wigwams.name)}</button>`).join('')}
      <button type="button" class="btn small danger" data-unfriend="${esc(f.id)}" aria-label="Unfriend">✕</button>
    </div>`).join('') : '<p class="muted empty">No friends yet. Invite someone with the button below.</p>';

  const v = social.friendView;
  el('friend-view').hidden = !v;
  if (v) {
    el('friend-view').innerHTML = `
      <div class="who"><b>${esc(v.owner)}'s ${esc(v.name)}</b> <span class="muted">· adding for:</span> ${state.wl.profiles.map((p) => kidChip(p, state.addKids.has(p.id), `data-add-kid="${esc(p.id)}"`)).join('')}</div>
      <div class="tiles">${v.sources.map((s, i) => `
        <div class="tile">
          ${s.thumb ? `<img class="${s.kind === 'channel' ? 'round' : ''}" src="${esc(s.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="tile-blank">▤</span>'}
          <div class="tile-title">${esc(s.title || s.handle || s.yt_id)}</div>
          <div class="muted small">${s.kind === 'channel' ? 'Channel' : 'Playlist'}</div>
          ${!s.yt_id ? '' : inLists(s.kind, s.yt_id) ? '<span class="muted small">✓ In your lists</span>' : `<button type="button" class="btn small" data-friend-add="${i}">＋ Add</button>`}
        </div>`).join('') || '<p class="muted">Nothing shared yet.</p>'}</div>`;
  }
  el('friend-invites').innerHTML = `
    ${social.friendInvites.map((i) => linkBox(i.token, 'friend')).join('')}
    ${social.friendInvites.length ? '<p class="muted small">When they open the link and sign in, you become friends. Each of you decides whether to share your own wigwam.</p>' : ''}
    <button type="button" class="btn" id="invite-friend">＋ Invite a friend</button>`;
  el('friends-count').textContent = social.friends.length;
}

el('friend-view').addEventListener('click', (e) => {
  const kid = e.target.closest('[data-add-kid]')?.dataset.addKid;
  if (!kid) return;
  state.addKids.has(kid) ? state.addKids.delete(kid) : state.addKids.add(kid);
  change(null);
});

// ---------------------------------------------------------------- YouTube

async function loadYouTube() {
  social.accounts = await must(sb.from('yt_accounts').select('*').order('created_at'));
  social.inbox = social.accounts.length
    ? await allRows(() => sb.from('yt_inbox').select('*').eq('dismissed', false).order('found_at', { ascending: false }))
    : [];
}

const REASONS = [['channel', 'Subscriptions'], ['playlist', 'Your playlists'], ['video', 'Liked videos']];

function renderYouTube() {
  el('yt-accounts').innerHTML = social.accounts.map((a) => `
    <div class="row">
      ${a.thumb ? `<img class="face" src="${esc(a.thumb)}" alt="" referrerpolicy="no-referrer">` : '<span class="face">▶</span>'}
      <div class="row-text"><b>${esc(a.title || 'YouTube channel')}</b>
        <div class="muted">${a.sync_error ? `<span class="warn">${esc(a.sync_error)}</span>` : a.synced_at ? `Checked ${esc(timeAgo(a.synced_at))}` : '<span class="dot"></span>Importing (about a minute)…'}</div></div>
      <label class="check"><input type="checkbox" data-autosync="${esc(a.id)}" ${a.auto_sync ? 'checked' : ''}> Check every night</label>
      <button type="button" class="btn small danger" data-disconnect="${esc(a.id)}">Disconnect</button>
    </div>`).join('');
  el('yt-connect').textContent = social.accounts.length ? '＋ Connect another YouTube channel' : 'Connect YouTube';
  el('yt-connect').disabled = !GOOGLE_CLIENT_ID;
  el('yt-note').hidden = !!GOOGLE_CLIENT_ID;

  const waiting = social.inbox.filter((i) => !inLists(i.kind, i.yt_id));
  el('inbox-wrap').hidden = !social.accounts.length;
  el('inbox-tabs').innerHTML = REASONS.map(([k, name]) => `<button type="button" class="tab ${social.inboxTab === k ? 'on' : ''}" data-inbox-tab="${k}">${name} <span class="n">${waiting.filter((i) => i.kind === k).length}</span></button>`).join('');
  const list = waiting.filter((i) => i.kind === social.inboxTab);
  el('inbox-kids').innerHTML = state.wl.profiles.map((p) => kidChip(p, state.addKids.has(p.id), `data-add-kid="${esc(p.id)}"`)).join('');
  el('inbox').innerHTML = list.length ? `
    <div class="tiles">${list.slice(0, social.inboxShown).map((i) => `
      <div class="tile">
        <a href="https://www.youtube.com/${i.kind === 'channel' ? 'channel/' + esc(i.yt_id) : i.kind === 'playlist' ? 'playlist?list=' + esc(i.yt_id) : 'watch?v=' + esc(i.yt_id)}" target="_blank" rel="noopener" title="Look on YouTube">
          <img class="${i.kind === 'channel' ? 'round' : ''}" src="${esc(i.thumb || (i.kind === 'video' ? thumbUrl(i.yt_id) : ''))}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>
        <div class="tile-title">${esc(i.title || i.yt_id)}</div>
        ${i.channel_title ? `<div class="muted small">${esc(i.channel_title)}</div>` : ''}
        <div class="tile-btns">
          <button type="button" class="btn small" data-inbox-add="${esc(i.kind)}:${esc(i.yt_id)}">＋ Add</button>
          <button type="button" class="link" data-dismiss="${esc(i.account_id)}|${esc(i.kind)}|${esc(i.yt_id)}">Not for kids</button>
        </div>
      </div>`).join('')}</div>
    ${list.length > social.inboxShown ? `<button type="button" class="btn more" data-inbox-more>Show more (${list.length - social.inboxShown} left)</button>` : ''}
    <p class="muted small">“Not for kids” takes it out of this list for good. Nothing here reaches the kids until you add it and publish.</p>`
    : `<p class="muted empty">${social.accounts.some((a) => !a.synced_at) ? 'Importing…' : 'Nothing new here.'}</p>`;
  el('yt-count').textContent = waiting.length || '';
}

el('yt-connect').addEventListener('click', () => {
  if (dirty() && !confirm('You have unpublished changes. Connecting YouTube leaves this page, so they\'ll be lost. Continue?')) return;
  const nonce = crypto.randomUUID();
  sessionStorage.setItem('wigwam-yt-state', nonce);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: adminUrl(), response_type: 'code', state: nonce,
    scope: 'https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline', prompt: 'consent select_account',
  });
  location.href = u.toString();
});

/** Back from Google with a code: let the server swap it for lasting access, then wait for the import. */
export async function finishYouTubeConnect(code) {
  try {
    const res = await invoke('youtube-connect', { code, redirect_uri: adminUrl() });
    toast(`✓ Connected ${res.account.title}. Bringing in its subscriptions, playlists and liked videos…`);
    el('youtube-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loadYouTube(); renderSocial();
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until && social.accounts.some((a) => !a.synced_at && !a.sync_error)) {
      await new Promise((r) => setTimeout(r, 10_000));
      await loadYouTube(); renderSocial();
    }
  } catch (err) { toast(`Couldn't connect YouTube: ${err.message}`, 'error'); }
}

el('youtube-card').addEventListener('click', async (e) => {
  const kid = e.target.closest('[data-add-kid]')?.dataset.addKid;
  if (kid) { state.addKids.has(kid) ? state.addKids.delete(kid) : state.addKids.add(kid); return change(null); }
  const t = e.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.inboxTab) { social.inboxTab = t.dataset.inboxTab; social.inboxShown = 30; }
    else if ('inboxMore' in t.dataset) social.inboxShown += 60;
    else if (t.dataset.inboxAdd) {
      const [kind, id] = t.dataset.inboxAdd.split(':');
      const item = social.inbox.find((i) => i.kind === kind && i.yt_id === id);
      return addToLists(kind, id, item?.title, 'from YouTube');
    } else if (t.dataset.dismiss) {
      const [account, kind, id] = t.dataset.dismiss.split('|');
      await must(sb.from('yt_inbox').update({ dismissed: true }).eq('account_id', account).eq('kind', kind).eq('yt_id', id));
      social.inbox = social.inbox.filter((i) => !(i.account_id === account && i.kind === kind && i.yt_id === id));
    } else if (t.dataset.disconnect) {
      const a = social.accounts.find((x) => x.id === t.dataset.disconnect);
      if (!confirm(`Disconnect ${a.title}? Its list here goes too. (To also revoke Wigwam's access at Google, visit myaccount.google.com/permissions.)`)) return;
      await must(sb.from('yt_accounts').delete().eq('id', a.id));
      await loadYouTube();
    } else return;
    renderYouTube();
  } catch (err) { toast(err.message, 'error'); }
});
el('youtube-card').addEventListener('change', async (e) => {
  const id = e.target.dataset.autosync;
  if (!id) return;
  try { await must(sb.from('yt_accounts').update({ auto_sync: e.target.checked }).eq('id', id)); }
  catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
});

// ---------------------------------------------------------------- recent changes

async function loadActivity() {
  social.activity = await must(sb.from('activity').select('message, created_at, user_id, profiles(name)').eq('wigwam_id', state.wigwam).order('created_at', { ascending: false }).limit(40));
}

function renderActivity() {
  el('activity').innerHTML = social.activity.length ? social.activity.map((a) => `
    <div class="act"><b>${esc(a.user_id === uid() ? 'You' : a.profiles?.name || 'Someone')}</b> ${esc(a.message)} <span class="muted">· ${esc(timeAgo(a.created_at))}</span></div>`).join('')
    : '<p class="muted empty">Nothing yet.</p>';
}

export { loadActivity };
