/**
 * 공용 로그인 — 프리패스 앱 공통. 화면을 고치지 말고 옵션만 갈아 끼운다.
 *
 *   mount(el, {
 *     brand:   { kind, wordmark, color, colorHover },  // 간판과 토큰
 *     policy:  'AUTO' | 'APPROVAL',                    // 가입 즉시 이용 / 승인 필요
 *     fields:  'basic' | 'sales',                      // 가입 폼 구성
 *     consent: boolean,                                // 약관·개인정보 필수 동의
 *     auth, firebase,                                  // Firebase Auth 인스턴스와 모듈
 *     onSignedIn()                                     // 로그인·인증이 끝난 뒤
 *   })
 *
 * ★Firebase만 자격증명을 다룬다. 이 파일은 비밀번호를 저장하지도, 토큰을 만들지도 않는다.
 */

const MESSAGES = {
  'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않습니다',
  'auth/wrong-password': '비밀번호가 올바르지 않습니다',
  'auth/user-not-found': '등록되지 않은 이메일입니다',
  'auth/invalid-email': '이메일 형식이 올바르지 않습니다',
  'auth/user-disabled': '비활성화된 계정입니다',
  'auth/too-many-requests': '시도가 많습니다. 잠시 후 다시 시도해주세요',
  'auth/network-request-failed': '네트워크 오류 — 연결을 확인해주세요',
  'auth/operation-not-allowed': '해당 로그인 방식이 비활성화되어 있습니다',
  'auth/email-already-in-use': '이미 사용 중인 이메일입니다',
  'auth/weak-password': '비밀번호는 6자 이상이어야 합니다',
  'auth/missing-email': '이메일을 입력해주세요',
  'auth/missing-password': '비밀번호를 입력해주세요'
};

const say = (error, fallback) => MESSAGES[error?.code] ?? error?.message ?? fallback;

const normalizedEmail = (value) => String(value ?? '').trim().toLowerCase();
const hasEmailShape = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** 숫자만 남겨 사업자번호 꼴로 끊는다. */
function formatBizNo(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '').slice(0, 10);
  if (digits.length > 5) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  if (digits.length > 3) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return digits;
}

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

function field(label, input, hint) {
  const wrap = el('label', { class: 'fpl-field' }, [el('span', { text: label }), input]);
  if (hint) wrap.append(hint);
  return wrap;
}

const input = (type, placeholder, autocomplete) =>
  el('input', { type, placeholder, autocomplete, spellcheck: 'false' });

/**
 * 간판을 세운다. `ours`는 우리 CI(Exo 2 두 무게 소문자), `channel`은 그 회사 공식 CI.
 * ⚠ 채널 이름에 우리 서체 규칙(소문자·Exo 2)을 씌우지 않는다.
 */
function brandMark(brand) {
  const slot = el('div', { class: 'fpl-brand', 'aria-label': brand.label ?? '' });
  for (const part of brand.wordmark ?? []) {
    slot.append(el('span', {
      text: part.text,
      style: [
        `font-family:${brand.kind === 'ours' ? "'Exo 2',sans-serif" : 'inherit'}`,
        `font-size:${part.size ?? (brand.kind === 'ours' ? 25 : 22)}px`,
        `font-weight:${part.weight ?? 600}`,
        `letter-spacing:${part.tracking ?? (brand.kind === 'ours' ? '-0.02em' : '0.06em')}`,
        brand.kind === 'ours' ? 'text-transform:lowercase' : '',
        `color:${part.color ?? 'var(--fpl-brand)'}`
      ].filter(Boolean).join(';')
    }));
  }
  return slot;
}

export function mount(root, options) {
  const {
    brand, auth, firebase,
    policy = 'APPROVAL',
    fields = 'basic',
    consent = false,
    onSignedIn = () => {}
  } = options;

  const host = el('div', { class: 'fpl' });
  if (brand?.color) host.style.setProperty('--fpl-brand', brand.color);
  if (brand?.colorHover) host.style.setProperty('--fpl-brand-hover', brand.colorHover);

  const page = el('div', { class: 'fpl-page' }, [brandMark(brand ?? {})]);
  host.append(page);
  root.replaceChildren(host);

  let mode = 'login';
  let busy = false;
  /**
   * 모드를 바꾸면 카드를 새로 그리므로, 바꾸기 «전» 카드에 쓴 문구는 버려진다.
   * 넘길 말은 여기 맡겨 두고 새 카드가 받아 간다 — 가입 직후 "메일 보냈습니다"가 이 경로다.
   */
  let handoff = null;

  const render = () => {
    // 새로 그린 카드는 처리 중일 수 없다. 이 줄이 없으면 가입 직후 넘어온 로그인 폼이
    // 앞 화면의 잠금을 그대로 물려받아 제출을 통째로 무시한다.
    busy = false;
    const card = el('form', { class: 'fpl-card', novalidate: 'novalidate' });
    const message = el('p', { class: 'fpl-msg', 'aria-live': 'polite' });
    const tell = (text, tone) => {
      message.textContent = text ?? '';
      message.className = `fpl-msg${tone ? ` is-${tone}` : ''}`;
    };
    const setBusy = (next, label) => {
      busy = next;
      card.querySelectorAll('button, input, select').forEach((node) => { node.disabled = next; });
      const veil = card.querySelector('.fpl-busy');
      if (veil) veil.remove();
      if (next) card.append(el('div', { class: 'fpl-busy', text: label ?? '처리 중…', 'aria-busy': 'true' }));
    };
    const go = (next, message) => { mode = next; handoff = message ?? null; render(); };

    const links = (...items) => {
      const row = el('div', { class: 'fpl-links' });
      items.forEach((item, index) => {
        if (index) row.append(el('span', { class: 'fpl-links-sep', text: '·' }));
        row.append(el('button', { type: 'button', text: item.text, onClick: item.onClick }));
      });
      return row;
    };

    if (mode === 'login') {
      const email = input('email', 'name@company.com', 'username');
      const password = input('password', '비밀번호 입력', 'current-password');
      card.append(
        el('header', { class: 'fpl-head' }, [
          el('h2', { class: 'fpl-title', text: '로그인' }),
          el('p', { class: 'fpl-sub', text: '이메일과 비밀번호를 입력해주세요.' })
        ]),
        el('div', { class: 'fpl-form' }, [
          field('이메일', email),
          field('비밀번호', password),
          el('button', { class: 'fpl-submit', type: 'submit', text: '로그인' })
        ]),
        links(
          { text: '계정 만들기', onClick: () => go('signup') },
          { text: '비밀번호 재설정', onClick: () => go('reset') }
        ),
        message
      );
      card.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy) return;
        const address = normalizedEmail(email.value);
        if (!hasEmailShape(address)) return tell('이메일 형식을 확인해주세요. 예: name@company.com', 'err');
        if (!password.value) return tell('비밀번호를 입력해주세요.', 'err');
        setBusy(true);
        tell('');
        try {
          await firebase.signInWithEmailAndPassword(auth, address, password.value);
          password.value = '';
          await onSignedIn();
        } catch (error) {
          setBusy(false);
          tell(say(error, '로그인 실패'), 'err');
        }
      });
    }

    if (mode === 'signup') {
      const email = input('email', 'name@company.com', 'username');
      const password = input('password', '6자 이상', 'new-password');
      const confirm = input('password', '비밀번호 재입력', 'new-password');
      const name = input('text', '홍길동', 'name');
      const mismatch = el('p', { class: 'fpl-hint is-miss', text: '비밀번호가 일치하지 않습니다', style: 'display:none' });
      confirm.addEventListener('input', () => {
        mismatch.style.display = confirm.value && confirm.value !== password.value ? '' : 'none';
      });

      const form = el('div', { class: 'fpl-form' }, [
        field('이메일 (필수)', email),
        field('비밀번호', password),
        field('비밀번호 확인', confirm, mismatch),
        field('이름', name)
      ]);

      let phone = null, company = null, bizNo = null, activity = null;
      if (fields === 'sales') {
        phone = input('tel', '010-0000-0000', 'tel');
        company = input('text', '나중에 입력해도 됩니다');
        bizNo = input('text', '나중에 입력해도 됩니다');
        bizNo.addEventListener('input', () => { bizNo.value = formatBizNo(bizNo.value); });
        activity = el('select', {}, [
          el('option', { value: '', text: '나중에 지정' }),
          el('option', { value: '공급', text: '공급사' }),
          el('option', { value: '영업', text: '영업(소속)' }),
          el('option', { value: '개인', text: '개인영업' })
        ]);
        form.append(
          field('연락처', phone),
          field('소속 회사명 (선택)', company),
          field('활동 유형 (선택)', activity),
          field('소속 사업자번호 (선택)', bizNo)
        );
      }

      form.append(el('p', {
        class: 'fpl-policy',
        text: policy === 'APPROVAL'
          ? '가입 신청 뒤 관리자가 승인해야 이용할 수 있습니다.'
          : '가입하면 바로 이용할 수 있습니다. 소속과 권한은 관리자 확인 후 연결됩니다.'
      }));

      let agreed = () => true;
      if (consent) {
        const terms = el('input', { type: 'checkbox' });
        const privacy = el('input', { type: 'checkbox' });
        const all = el('input', { type: 'checkbox' });
        const sync = () => { all.checked = terms.checked && privacy.checked; submit.disabled = !agreed(); };
        all.addEventListener('change', () => {
          terms.checked = all.checked;
          privacy.checked = all.checked;
          submit.disabled = !agreed();
        });
        terms.addEventListener('change', sync);
        privacy.addEventListener('change', sync);
        agreed = () => terms.checked && privacy.checked;
        form.append(el('div', { class: 'fpl-consent' }, [
          el('label', { class: 'fpl-all' }, [all, el('span', { text: '전체 동의' })]),
          el('label', {}, [terms, el('span' , {}, [
            document.createTextNode('[필수] '),
            el('a', { href: '/terms', target: '_blank', rel: 'noopener noreferrer', text: '이용약관' }),
            document.createTextNode('에 동의합니다')
          ])]),
          el('label', {}, [privacy, el('span', {}, [
            document.createTextNode('[필수] '),
            el('a', { href: '/privacy', target: '_blank', rel: 'noopener noreferrer', text: '개인정보 수집·이용' }),
            document.createTextNode('에 동의합니다')
          ])]),
          el('p', { text: '수집 항목: 이메일·이름(필수) · 목적: 회원 식별과 서비스 제공 · 보유: 이용계약 종료 시까지' })
        ]));
      }

      const submit = el('button', { class: 'fpl-submit', type: 'submit', text: '계정 만들기' });
      submit.disabled = !agreed();
      form.append(submit);

      card.append(
        el('header', { class: 'fpl-head' }, [
          el('h2', { class: 'fpl-title', text: '계정 만들기' }),
          el('p', { class: 'fpl-sub', text: '가입하면 인증 메일이 갑니다.' })
        ]),
        form,
        links({ text: '로그인으로 돌아가기', onClick: () => go('login') }),
        message
      );

      card.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy) return;
        const address = normalizedEmail(email.value);
        if (!hasEmailShape(address) || password.value.length < 6) {
          return tell('이메일 형식과 비밀번호(6자 이상)를 확인해주세요', 'err');
        }
        if (password.value !== confirm.value) return tell('비밀번호가 일치하지 않습니다', 'err');
        if (!name.value.trim()) return tell('이름을 입력해주세요', 'err');
        if (!agreed()) return tell('이용약관·개인정보 수집·이용에 모두 동의해야 가입할 수 있습니다', 'err');
        setBusy(true);
        tell('');
        try {
          const created = await firebase.createUserWithEmailAndPassword(auth, address, password.value);
          await firebase.updateProfile(created.user, { displayName: name.value.trim() });
          await firebase.sendEmailVerification(created.user);
          go('login', { text: '인증 메일을 보냈습니다. 링크를 누른 뒤 로그인하세요.', tone: 'ok' });
        } catch (error) {
          setBusy(false);
          tell(say(error, '가입 실패'), 'err');
        }
      });
    }

    if (mode === 'reset') {
      const email = input('email', 'name@company.com', 'username');
      card.append(
        el('header', { class: 'fpl-head' }, [
          el('h2', { class: 'fpl-title', text: '비밀번호 재설정' }),
          el('p', { class: 'fpl-sub', text: '가입한 이메일로 재설정 링크를 보내드립니다.' })
        ]),
        el('div', { class: 'fpl-form' }, [
          field('이메일', email),
          el('button', { class: 'fpl-submit', type: 'submit', text: '재설정 메일 전송' })
        ]),
        links({ text: '로그인으로 돌아가기', onClick: () => go('login') }),
        message
      );
      card.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy) return;
        const address = normalizedEmail(email.value);
        if (!hasEmailShape(address)) return tell('이메일 형식을 확인해주세요. 예: name@company.com', 'err');
        setBusy(true);
        tell('전송 중…');
        try {
          await firebase.sendPasswordResetEmail(auth, address);
          tell('재설정 메일 전송됨. 이메일(스팸함 포함)을 확인하세요.', 'ok');
        } catch (error) {
          tell(say(error, '전송 실패'), 'err');
        } finally {
          // 성공해도 반드시 푼다 — 안 그러면 메일이 스팸으로 갔을 때 재전송할 길이 없다.
          setBusy(false);
        }
      });
    }

    const previous = page.querySelector('.fpl-card');
    if (previous) previous.replaceWith(card);
    else page.append(card);
    if (handoff) { tell(handoff.text, handoff.tone); handoff = null; }
    // 모드를 바꾸면 첫 칸으로 초점을 옮긴다. 키보드만 쓰는 사람이 매번 탭으로 내려오지 않게.
    card.querySelector('input')?.focus({ preventScroll: true });
  };

  render();

  return {
    destroy: () => host.remove(),
    showMessage: (text, tone) => {
      const message = host.querySelector('.fpl-msg');
      if (!message) return;
      message.textContent = text ?? '';
      message.className = `fpl-msg${tone ? ` is-${tone}` : ''}`;
    }
  };
}

export const FREEPASS_DATA_BRAND = {
  kind: 'ours',
  label: 'freepass data',
  color: '#1B2A4A',
  colorHover: '#24365E',
  wordmark: [
    { text: 'freepass', weight: 600 },
    { text: 'data', weight: 300, color: '#7F93B3' }
  ]
};
