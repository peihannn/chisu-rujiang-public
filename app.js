    function clearElement(element) {
      while (element && element.firstChild) element.removeChild(element.firstChild);
    }
    function removeElement(element) {
      if (element && element.parentNode) element.parentNode.removeChild(element);
    }
    function mapToObject(map, projector) {
      const output = {};
      map.forEach((value, key) => {
        output[key] = projector ? projector(value, key) : value;
      });
      return output;
    }
    const AudioController = (() => {
      const tracks = {
        river: { gain:.135, loop:true },
        bamboo: { gain:.05, loop:true },
        boat: { gain:.095, max:1 },
        paper: { gain:.13, max:1 },
        firefly: { gain:.045, max:1 },
        cup: { gain:.15, max:1 }
      };
      const sceneMixes = {
        landing: { river:.11, bamboo:.05 },
        compose: { river:.125, bamboo:.05 },
        journey: { river:.135, bamboo:.035 },
        weave: { river:.135, bamboo:.025 },
        act2: { river:.135, bamboo:.015 },
        pavilionArrival: { river:.095, bamboo:0 },
        ending: { river:.085, bamboo:0 }
      };
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const buffers = new Map();
      const decodePromises = new Map();
      const decodeFailures = new Set();
      const ambience = new Map();
      const activeShots = new Set();
      const playCounts = new Map();
      let context = null;
      let unlocked = false;
      let muted = false;
      let currentScene = 'landing';
      let runGeneration = 0;

      function ensureContext() {
        if (context || !AudioContextClass) return context;
        try {
          context = new AudioContextClass();
        } catch (_) {
          context = null;
        }
        return context;
      }

      function safeResume() {
        const audioContext = ensureContext();
        if (!audioContext || audioContext.state === 'running') return Promise.resolve(Boolean(audioContext));
        try {
          const resumed = audioContext.resume();
          return resumed && typeof resumed.catch === 'function' ? resumed.then(() => true).catch(() => false) : Promise.resolve(true);
        } catch (_) {
          return Promise.resolve(false);
        }
      }

      function base64ToArrayBuffer(encoded) {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes.buffer;
      }

      function decodeTrack(name) {
        if (buffers.has(name)) return Promise.resolve(buffers.get(name));
        if (decodePromises.has(name)) return decodePromises.get(name);
        const audioContext = ensureContext();
        const encoded = window.CHISU_AUDIO_DATA && window.CHISU_AUDIO_DATA[name];
        if (!audioContext || typeof encoded !== 'string' || !encoded) {
          decodeFailures.add(name);
          return Promise.resolve(null);
        }
        let bytes;
        try {
          bytes = base64ToArrayBuffer(encoded);
        } catch (_) {
          decodeFailures.add(name);
          return Promise.resolve(null);
        }
        const decoding = new Promise(resolve => {
          let settled = false;
          const succeed = buffer => {
            if (settled) return;
            settled = true;
            if (buffer) {
              buffers.set(name, buffer);
              decodeFailures.delete(name);
              resolve(buffer);
            } else {
              decodeFailures.add(name);
              resolve(null);
            }
          };
          const fail = () => {
            if (settled) return;
            settled = true;
            decodeFailures.add(name);
            resolve(null);
          };
          try {
            const result = audioContext.decodeAudioData(bytes.slice(0), succeed, fail);
            if (result && typeof result.then === 'function') result.then(succeed, fail);
          } catch (_) {
            fail();
          }
        });
        decodePromises.set(name, decoding);
        return decoding;
      }

      function decodeAll() {
        return Promise.all(Object.keys(tracks).map(decodeTrack));
      }

      function scheduleGain(gainNode, value, duration) {
        const audioContext = ensureContext();
        if (!audioContext || !gainNode) return;
        const destination = Math.max(0, Math.min(1, value));
        const now = audioContext.currentTime;
        const current = Number.isFinite(gainNode.gain.value) ? gainNode.gain.value : 0;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(current, now);
        if (duration > 0) gainNode.gain.linearRampToValueAtTime(destination, now + duration / 1000);
        else gainNode.gain.setValueAtTime(destination, now);
      }

      function ensureAmbience(name) {
        if (ambience.has(name)) return ambience.get(name);
        const audioContext = ensureContext();
        const buffer = buffers.get(name);
        if (!audioContext || !buffer || !tracks[name] || !tracks[name].loop) return null;
        try {
          const source = audioContext.createBufferSource();
          const gainNode = audioContext.createGain();
          source.buffer = buffer;
          source.loop = true;
          gainNode.gain.value = 0;
          source.connect(gainNode);
          gainNode.connect(audioContext.destination);
          const record = { source, gainNode };
          source.onended = () => {
            if (ambience.get(name) === record) ambience.delete(name);
            try { source.disconnect(); gainNode.disconnect(); } catch (_) { /* Silent cleanup. */ }
          };
          source.start(0);
          ambience.set(name, record);
          return record;
        } catch (_) {
          return null;
        }
      }

      function stopAmbience() {
        ambience.forEach(({ source, gainNode }) => {
          try { source.onended = null; source.stop(); } catch (_) { /* Already stopped. */ }
          try { source.disconnect(); gainNode.disconnect(); } catch (_) { /* Silent cleanup. */ }
        });
        ambience.clear();
      }

      function stopShots() {
        activeShots.forEach(record => {
          try { record.source.onended = null; record.source.stop(); } catch (_) { /* Already stopped. */ }
          try { record.source.disconnect(); record.gainNode.disconnect(); } catch (_) { /* Silent cleanup. */ }
        });
        activeShots.clear();
      }

      function fadeAmbience(targets, duration = 800) {
        const audioContext = ensureContext();
        if (!audioContext) return;
        const shouldPlay = unlocked && !muted && !document.hidden;
        if (shouldPlay) void safeResume();
        const requested = { river:targets.river == null ? 0 : targets.river, bamboo:targets.bamboo == null ? 0 : targets.bamboo };
        Object.entries(tracks).forEach(([name, config]) => {
          if (!config.loop) return;
          const record = shouldPlay ? ensureAmbience(name) : ambience.get(name);
          if (record) scheduleGain(record.gainNode, shouldPlay ? requested[name] : 0, duration);
        });
      }

      function setScene(name, duration = 900) {
        currentScene = sceneMixes[name] ? name : currentScene;
        fadeAmbience(sceneMixes[currentScene], duration);
      }

      function unlock() {
        const firstUnlock = !unlocked;
        unlocked = true;
        const audioContext = ensureContext();
        if (!audioContext) return false;
        void safeResume();
        if (firstUnlock) {
          try {
            const warmup = audioContext.createBufferSource();
            warmup.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
            warmup.connect(audioContext.destination);
            warmup.start(0);
          } catch (_) { /* Resume is sufficient when warmup is unavailable. */ }
        }
        void decodeAll().then(() => fadeAmbience(sceneMixes[currentScene], firstUnlock ? 900 : 240));
        return true;
      }

      function playOneShot(name) {
        const config = tracks[name];
        if (!config || config.loop || !unlocked || muted || document.hidden) return false;
        const played = playCounts.get(name) || 0;
        if (played >= (config.max == null ? 1 : config.max)) return false;
        playCounts.set(name, played + 1);
        const generation = runGeneration;
        const start = buffer => {
          if (!buffer || generation !== runGeneration || muted || document.hidden) return false;
          const audioContext = ensureContext();
          if (!audioContext) return false;
          try {
            const source = audioContext.createBufferSource();
            const gainNode = audioContext.createGain();
            source.buffer = buffer;
            source.loop = false;
            gainNode.gain.value = config.gain;
            source.connect(gainNode);
            gainNode.connect(audioContext.destination);
            const record = { source, gainNode };
            const clean = () => {
              activeShots.delete(record);
              try { source.disconnect(); gainNode.disconnect(); } catch (_) { /* Silent cleanup. */ }
            };
            source.onended = clean;
            activeShots.add(record);
            source.start(0);
            return true;
          } catch (_) {
            return false;
          }
        };
        const buffer = buffers.get(name);
        if (buffer) start(buffer);
        else void decodeTrack(name).then(start);
        return true;
      }

      function duck(targets, duration = 650) {
        fadeAmbience(targets, duration);
      }

      function setMuted(nextMuted) {
        muted = Boolean(nextMuted);
        if (muted) stopShots();
        fadeAmbience(sceneMixes[currentScene], muted ? 180 : 500);
        return muted;
      }

      function resetRun() {
        runGeneration += 1;
        stopShots();
        stopAmbience();
        playCounts.clear();
        currentScene = 'landing';
        if (unlocked && !muted && !document.hidden) setScene('landing', 500);
      }

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          stopShots();
          ambience.forEach(({ gainNode }) => scheduleGain(gainNode, 0, 0));
          try {
            if (context && typeof context.suspend === 'function') {
              const suspended = context.suspend();
              if (suspended && typeof suspended.catch === 'function') void suspended.catch(() => false);
            }
          } catch (_) { /* Silent fallback. */ }
        } else if (unlocked && !muted) {
          void safeResume().then(() => setScene(currentScene, 700));
        }
      });

      return {
        unlock,
        setScene,
        playOneShot,
        duck,
        setMuted,
        resetRun,
        getState:() => ({
          unlocked,
          muted,
          currentScene,
          contextState:(context && context.state) || 'unavailable',
          decoded:Array.from(buffers.keys()),
          decodeFailures:Array.from(decodeFailures),
          activeShots:activeShots.size,
          playCounts:mapToObject(playCounts),
          ambience:mapToObject(ambience, record => ({
            active:true,
            gain:Number(record.gainNode.gain.value.toFixed(3))
          }))
        })
      };
    })();
    const opening = '旧案上铺着一张纸。你还没有落款。水声从竹帘外漫进来，纸角微微一湿。老人说，有什么话，投进江里就好。它会顺着灯光，漂到那个也该收到信的人手里。你蘸了墨，笔在指间停了一停。';
    const journeys = {
      '去':'信箱留着半圈旧胶印，你抬手擦掉门牌上的灰，门里的人看你一眼，把门关上。',
      '做':'桌上摆着刚做完的东西，你扶正拍下一张照，屏幕亮起时，置顶头像已经换了。',
      '说':'聊天框停在六年前，你重新打出那句话，拇指悬在发送键，最后一格一格删掉。',
      '放':'纸箱上压着那把旧钥匙，你从钥匙圈上拧下来放进去，胶带拉过箱口盖住号码。',
      '写':'信纸旁压着两张旧票根，你写完最后一行扣上笔，窗外招牌熄灭，地址仍空着。'
    };
    const weave = {
      a:'你记起一个很普通的晚上。几个人坐在一起吃饭，菜已经凉了，也没人急着走。那时候你们都觉得以后还会经常见面。后来有人去了别的城市，有人成了父母，有人换了号码。那顿饭没有什么特别，现在却想不起下一次是什么时候。',
      b:'以前说过很多以后。一起做件事，等有钱了去一个地方，父母老了住近一点，孩子出生了要通知，等忙完这一阵再好好聊。没有谁故意食言。只是后来每个人都有了新的事要先处理。',
      c:'真正走散的那天其实没人注意。可能只是最后一次下班后没有一起吃饭，最后一个没有回复的消息，最后一次回家时少问了一句。没有争吵，也没有告别。很久以后，你才发现那就是最后一次。'
    };
    const storyState = {
      originChoice: '去',
      destinationChoice: null,
      currentAct: 1,
      currentScene: 'landing',
      currentBeat: 0,
      netAction: null
    };
    let page = 'landing', chosen = '去', typed = false, revealIndex = 0, holdTimer;
    const clearCinematicAttention = () => {
      document.querySelectorAll('.scene').forEach(scene => scene.classList.remove(
        'is-cinematic-text-focus',
        'is-cinematic-interaction-hold',
        'is-cinematic-ending-still'
      ));
    };
    const show = name => {
      document.getElementById(page).classList.remove('active');
      clearCinematicAttention();
      page=name;
      storyState.currentScene=name;
      document.getElementById(page).classList.add('active');
      AudioController.setScene(name);
    };
    const lines = [
      '旧案上铺着一张纸',
      '你还没有落款',
      '水声从竹帘外漫进来',
      '纸角微微一湿',
      '老人说有什么话',
      '投进江里就好',
      '它会顺着灯光',
      '漂到那个也该收到信的人手里',
      '你蘸了墨',
      '笔在指间停了一停'
    ];
    const container = document.getElementById('openingText');
    let lineIndex = 0;
    let charIndex = 0;
    function typeWriter() {
      if (lineIndex < lines.length) {
        const currentLine = lines[lineIndex];
        if (charIndex <= currentLine.length) {
          let textToShow = '';
          for (let i = 0; i < lineIndex; i++) {
            textToShow += lines[i] + '<br>';
          }
          textToShow += currentLine.substring(0, charIndex);
          container.innerHTML = textToShow;
          charIndex++;
          setTimeout(typeWriter, 150);
        } else {
          lineIndex++;
          charIndex = 0;
          setTimeout(typeWriter, 300);
        }
      } else {
        document.querySelector('.landing-hint').classList.add('is-visible');
        typed = true;
      }
    }
    document.getElementById('landing').addEventListener('click', () => {
      AudioController.unlock();
      if (typed) show('compose');
    });
    const journeyBeats = {
      '去': [['信箱留着半圈旧胶印，', '你抬手擦掉门牌上的灰，'], ['门里的人看你一眼，', '把门关上。']],
      '做': [['桌上摆着刚做完的东西', '你扶正拍下一张照'], ['屏幕亮起时', '置顶头像已经换了']],
      '说': [['聊天框停在六年前，', '你重新打出那句话，'], ['拇指悬在发送键，', '最后一格一格删掉。']],
      '放': [['纸箱上压着那把旧钥匙，', '你从钥匙圈上拧下来放进去，'], ['胶带拉过箱口，', '盖住号码。']],
      '写': [['信纸旁压着两张旧票根，', '你写完最后一行扣上笔，'], ['窗外招牌熄灭，', '地址仍空着。']]
    };
    const journeyBeat = document.getElementById('journeyBeat');
    let journeyBeatIndex = 0;
    let journeyTransitioning = false;
    const cleanJourneyNarrative = text => text.replace(/[，。！？；：、,.!?;:“”‘’（）()《》〈〉【】\[\]——…]/g, '');
    function renderJourneyBeat({ immediate = false } = {}) {
      const columns = journeyBeats[chosen][journeyBeatIndex];
      journeyTransitioning = true;
      document.getElementById('journey').classList.add('is-cinematic-text-focus');
      journeyBeat.classList.remove('is-visible');
      window.setTimeout(() => {
        clearElement(journeyBeat);
        columns.forEach((line, index) => {
          const column = document.createElement('span');
          column.className = 'vertical-column';
          column.textContent = cleanJourneyNarrative(line);
          column.style.setProperty('--column-delay', `${index * 110}ms`);
          journeyBeat.appendChild(column);
        });
        requestAnimationFrame(() => journeyBeat.classList.add('is-visible'));
        journeyTransitioning = false;
      }, immediate ? 0 : 520);
    }
    document.querySelectorAll('#compose .menu-item[data-choice]').forEach(item => item.addEventListener('click', () => {
      chosen = item.dataset.choice;
      storyState.originChoice = chosen;
      storyState.currentBeat = 0;
      journeyBeatIndex = 0;
      show('journey');
      renderJourneyBeat({ immediate: true });
    }));
    document.getElementById('journey').addEventListener('click', () => {
      if (journeyTransitioning) return;
      if (journeyBeatIndex < journeyBeats[chosen].length - 1) {
        journeyBeatIndex++;
        renderJourneyBeat();
      } else {
        journeyTransitioning = true;
        journeyBeat.classList.remove('is-visible');
        window.setTimeout(() => {
          document.getElementById('journey').classList.remove('is-cinematic-text-focus');
          journeyTransitioning = false;
          show('weave');
        }, 620);
      }
    });
    let choiceResolving = false;
    document.querySelectorAll('#weave .cinematic-choice').forEach(choice => choice.addEventListener('click', () => {
      if (choiceResolving) return;
      choiceResolving = true;
      storyState.destinationChoice = choice.dataset.destination;
      const stage = document.querySelector('#weave .cinematic-choice-stage');
      stage.classList.add('is-selecting');
      choice.classList.add('is-selected');
      window.setTimeout(() => {
        stage.classList.add('is-departing');
        window.setTimeout(beginDeliveryFromWeave, 500);
      }, 520);
    }));
    const act2Scene = document.getElementById('act2');
    const act2Narrative = document.getElementById('act2Narrative');
    const act2ChoiceStage = document.getElementById('act2ChoiceStage');
    const act2NetPaper = document.querySelector('#act2 .act2-net-paper');
    const act2WaterPaper = document.querySelector('#act2 .act2-water-paper');
    const act2Ripple = document.querySelector('#act2 .act2-ripple');
    const act2PaperBoat = document.getElementById('act2PaperBoat');
    const act2PaperLabel = document.getElementById('act2PaperLabel');
    const pavilionArrival = document.getElementById('pavilionArrival');
    const pavilionNarrative = document.getElementById('pavilionNarrative');
    const pavilionWaterAffordance = document.getElementById('pavilionWaterAffordance');
    const pavilionWaterRipple = document.getElementById('pavilionWaterRipple');
    const pavilionLanternAnswer = document.getElementById('pavilionLanternAnswer');
    const pavilionReflectionHitTarget = document.getElementById('pavilionReflectionHitTarget');
    const pavilionReflectionHint = document.getElementById('pavilionReflectionHint');
    const pavilionFireflyGuide = document.getElementById('pavilionFireflyGuide');
    const pavilionEnding = document.getElementById('pavilionEnding');
    const pavilionEndingTitle = document.getElementById('pavilionEndingTitle');
    let act2Phase = 'idle', act2Locked = false, act2TimelineToken = 0;
    let act2Timers = [];
    const riverPaperLayout = { x:.29, y:.70, width:.105, compression:.62, rotation:-8 };
    let riverPaperPhase = 'hidden', riverPaperLocked = false, riverPaperLayer = null, riverPaperHitTarget = null;
    let riverPaperContext = null, riverPaperFrame = 0, riverPaperStartedAt = 0, riverPaperPressedAt = 0, riverPaperOcclusionAt = 0, riverPaperHintAt = 0, riverPaperHintTimer = 0, riverPaperResizeObserver = null, riverPaperWindowResizeListening = false;
    let riverPaperBounds = null, riverPaperComposite = null, riverPaperCompositeContext = null;
    const riverPaperTexture = new Image();
    const riverPaperBackground = document.querySelector('#act2 > .scene-art-frame > .scene-art');
    riverPaperTexture.src = 'assets/interaction1_old_paper.webp';
    let pavilionInteractionPhase = 'hidden', pavilionInteractionLocked = false, pavilionEndingPhase = 'idle';
    const pavilionFireflyFadeMs = 550;
    const pavilionFireflyPathMs = 3700;
    const pavilionFireflyApproachMs = 850;
    const act2Branches = {
      net: [
        ['网眼里卡着一角纸', '水已经把字泡开了'],
        ['你伸手去取', '纸却先碎了一小块']
      ],
      water: [
        ['纸贴着水走了一阵', '没有沉'],
        ['船夫没有回头', '只是把篙换到了另一边']
      ]
    };
    const originCallbacks = {
      '去': ['有些路走过以后', '才知道哪里算回来'],
      '做': ['桌上的东西冷了', '手上的温度还在'],
      '说': ['那句话没有发出去', '却一直停在那里'],
      '放': ['水先替你松了手', '岸还没有到'],
      '写': ['字落下来以后', '已经不是原来的话']
    };
    function setAct2Phase(phase) {
      act2Phase = phase;
    }
    function queueAct2(delay, callback) {
      const token = act2TimelineToken;
      const timer = window.setTimeout(() => {
        if (token === act2TimelineToken) callback();
      }, delay);
      act2Timers.push(timer);
      return timer;
    }
    function clearAct2Timers() {
      act2Timers.forEach(timer => clearTimeout(timer));
      act2Timers = [];
    }
    function mountAct2Narrative(lines, stagger = 110) {
      act2Scene.classList.add('is-cinematic-text-focus');
      act2Narrative.classList.remove('is-visible', 'is-fading');
      clearElement(act2Narrative);
      lines.forEach((line, index) => {
        const column = document.createElement('span');
        column.className = 'act2-column';
        column.textContent = cleanJourneyNarrative(line);
        column.style.setProperty('--act2-delay', `${index * stagger}ms`);
        act2Narrative.appendChild(column);
      });
      requestAnimationFrame(() => act2Narrative.classList.add('is-visible'));
    }
    function renderAct2Narrative(lines) { mountAct2Narrative(lines); }
    function unmountAct2Narrative() {
      act2Scene.classList.remove('is-cinematic-text-focus');
      act2Narrative.classList.remove('is-visible', 'is-fading');
      clearElement(act2Narrative);
    }
    function fadeOutAct2Narrative(callback, duration = 650) {
      act2Narrative.classList.add('is-fading');
      queueAct2(duration, () => {
        unmountAct2Narrative();
        if (typeof callback === 'function') callback();
      });
    }
    function clearAct2Narrative() { unmountAct2Narrative(); }
    function clearRiverPaperInteraction() {
      act2Scene.classList.remove('is-cinematic-interaction-hold');
      cancelAnimationFrame(riverPaperFrame);
      clearTimeout(riverPaperHintTimer);
      riverPaperHintTimer = 0;
      riverPaperHintAt = 0;
      if (riverPaperResizeObserver) riverPaperResizeObserver.disconnect();
      riverPaperResizeObserver = null;
      if (riverPaperWindowResizeListening) {
        window.removeEventListener('resize', resizeRiverPaperCanvas);
        riverPaperWindowResizeListening = false;
      }
      removeElement(riverPaperLayer);
      removeElement(riverPaperHitTarget);
      riverPaperLayer = null;
      riverPaperHitTarget = null;
      riverPaperContext = null;
      riverPaperBounds = null;
      riverPaperPhase = 'hidden';
      riverPaperLocked = false;
    }
    function resizeRiverPaperCanvas() {
      if (!riverPaperLayer || !riverPaperContext) return;
      const box = riverPaperLayer.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      riverPaperLayer.width = Math.max(1, Math.round(box.width * ratio));
      riverPaperLayer.height = Math.max(1, Math.round(box.height * ratio));
      riverPaperContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    function getRiverPaperMetrics(sceneWidth, sceneHeight, time) {
      const waiting = riverPaperPhase === 'WAITING';
      const reveal = riverPaperPhase === 'revealing' ? Math.min(1, (time - riverPaperStartedAt) / 700) : 1;
      const eased = 1 - Math.pow(1 - reveal, 3);
      const floatX = waiting ? Math.sin(time * .00031) * .35 : 0;
      const floatY = waiting ? Math.sin(time * .00047) * .22 : 0;
      const pressed = riverPaperPhase === 'PRESSED' ? Math.min(1, (time - riverPaperPressedAt) / 850) : 0;
      const occluding = riverPaperPhase === 'OCCLUDING';
      const occlusionProgress = occluding ? Math.min(1, (time - riverPaperOcclusionAt) / 1750) : 0;
      const occlusionEase = occlusionProgress * occlusionProgress * (3 - 2 * occlusionProgress);
      const pressDepth = 14;
      const settleDepth = riverPaperPhase === 'PRESSED' ? pressed * pressDepth : (occluding ? pressDepth : 0);
      const visibleWidth = Math.min(180, Math.max(82, sceneWidth * riverPaperLayout.width));
      const width = visibleWidth;
      const height = width / (riverPaperTexture.naturalWidth / riverPaperTexture.naturalHeight) * riverPaperLayout.compression;
      return {
        x: sceneWidth * riverPaperLayout.x + (occluding ? Math.sin(occlusionProgress * Math.PI) * .8 : 0) + floatX,
        y: sceneHeight * riverPaperLayout.y + settleDepth + (occluding ? Math.sin(occlusionProgress * Math.PI) * .35 : 0) + floatY,
        width, height,
        opacity:.92 * eased,
        scale:(.985 + eased * .015) * (1 - occlusionEase * .04),
        submersion:occlusionEase,
        blur: occluding ? Math.max(0, (occlusionEase - .78) / .22) * .32 : 0,
        rotation:(riverPaperLayout.rotation + (waiting ? Math.sin(time * .00028) * .06 : 0) + (riverPaperPhase === 'PRESSED' ? pressed * 3 : 0) + (occluding ? 3 + Math.sin(occlusionProgress * Math.PI) * .12 : 0)) * Math.PI / 180
      };
    }
    function ensureRiverPaperComposite(width, height) {
      const density = 2, pixelWidth = Math.ceil(width * density), pixelHeight = Math.ceil(height * density);
      if (!riverPaperComposite || riverPaperComposite.width !== pixelWidth || riverPaperComposite.height !== pixelHeight) {
        riverPaperComposite = document.createElement('canvas');
        riverPaperComposite.width = pixelWidth;
        riverPaperComposite.height = pixelHeight;
        riverPaperCompositeContext = riverPaperComposite.getContext('2d');
      }
      return density;
    }
    function drawRiverSampleIntoPaper(metrics, sceneWidth, sceneHeight) {
      if (!riverPaperBackground.complete || !riverPaperBackground.naturalWidth || !riverPaperTexture.complete || !riverPaperTexture.naturalWidth) return false;
      const density = ensureRiverPaperComposite(metrics.width, metrics.height);
      const context = riverPaperCompositeContext;
      const width = metrics.width, height = metrics.height;
      context.setTransform(density, 0, 0, density, 0, 0);
      context.clearRect(0, 0, width, height);
      const cover = Math.max(sceneWidth / riverPaperBackground.naturalWidth, sceneHeight / riverPaperBackground.naturalHeight);
      const renderedWidth = riverPaperBackground.naturalWidth * cover, renderedHeight = riverPaperBackground.naturalHeight * cover;
      const offsetX = (sceneWidth - renderedWidth) / 2, offsetY = (sceneHeight - renderedHeight) / 2;
      const sourceX = (metrics.x - width / 2 - offsetX) / cover;
      const sourceY = (metrics.y - height / 2 - offsetY) / cover;
      const sourceWidth = width / cover, sourceHeight = height / cover;
      context.drawImage(riverPaperBackground, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
      context.globalCompositeOperation = 'destination-in';
      context.filter = 'blur(.3px)';
      context.drawImage(riverPaperTexture, 0, 0, width, height);

      // Keep the river visible through the fragment, but let the fibres and folds read
      // before the water begins to consume it. The alpha cutout remains the only edge.
      context.globalCompositeOperation = 'source-atop';
      context.filter = 'saturate(.48) contrast(1.04) brightness(.98)';
      context.globalAlpha = .46;
      context.drawImage(riverPaperTexture, 0, 0, width, height);
      // A second, deliberately low-weight material pass only restores the folded
      // fibre detail. It remains clipped by the torn alpha silhouette, so no
      // perimeter or rectangular backing is introduced.
      context.filter = 'saturate(.38) contrast(1.18) brightness(.9)';
      context.globalAlpha = .13;
      context.drawImage(riverPaperTexture, 0, 0, width, height);
      context.globalAlpha = 1;
      context.filter = 'none';

      const paperTone = context.createLinearGradient(0, 0, 0, height);
      paperTone.addColorStop(0, 'rgba(231,208,174,.1)');
      paperTone.addColorStop(.42, 'rgba(196,163,124,.065)');
      paperTone.addColorStop(.74, 'rgba(117,91,66,.13)');
      paperTone.addColorStop(1, 'rgba(174,147,112,.27)');
      context.fillStyle = paperTone;
      context.fillRect(0, 0, width, height);
      if (metrics.submersion > 0) {
        const waterTint = context.createLinearGradient(0, 0, 0, height);
        waterTint.addColorStop(0, `rgba(220,192,149,${metrics.submersion * .025})`);
        waterTint.addColorStop(.55, `rgba(202,171,130,${metrics.submersion * .13})`);
        waterTint.addColorStop(1, `rgba(171,140,103,${metrics.submersion * .34})`);
        context.globalCompositeOperation = 'source-atop';
        context.fillStyle = waterTint;
        context.fillRect(0, 0, width, height);

        // Several irregular vertical mask fronts let the river consume lower torn edges first.
        context.globalCompositeOperation = 'destination-out';
        const fronts = [.08, .2, .33, .47, .61, .76, .91];
        fronts.forEach((offset, index) => {
          const irregularity = Math.sin((offset * 12.7) + metrics.submersion * 7.3) * height * .052;
          const front = height * (1 - metrics.submersion) + irregularity;
          const fade = height * (.08 + (index % 3) * .017);
          const occlusion = context.createLinearGradient(0, front - fade, 0, front + fade * 1.9);
          occlusion.addColorStop(0, 'rgba(0,0,0,0)');
          occlusion.addColorStop(.45, `rgba(0,0,0,${.24 + metrics.submersion * .3})`);
          occlusion.addColorStop(1, `rgba(0,0,0,${.62 + metrics.submersion * .38})`);
          context.fillStyle = occlusion;
          context.fillRect(width * (offset - .1), 0, width * .2, height);
        });
      }
      context.globalCompositeOperation = 'source-over';
      return true;
    }
    function drawRiverPaperCanvas(time) {
      if (!riverPaperLayer || !riverPaperContext || !riverPaperLayer.isConnected) return;
      const context = riverPaperContext;
      const box = riverPaperLayer.getBoundingClientRect();
      const width = box.width, height = box.height;
      context.clearRect(0, 0, width, height);
      if (!riverPaperTexture.complete || !riverPaperBackground.complete) {
        riverPaperFrame = requestAnimationFrame(drawRiverPaperCanvas);
        return;
      }
      const metrics = getRiverPaperMetrics(width, height, time);
      if (!drawRiverSampleIntoPaper(metrics, width, height)) { riverPaperFrame = requestAnimationFrame(drawRiverPaperCanvas); return; }
      riverPaperBounds = metrics;
      if (riverPaperHitTarget) {
        const padding = Math.min(18, Math.max(12, metrics.width * .08));
        riverPaperHitTarget.style.left = `${metrics.x - metrics.width / 2 - padding}px`;
        riverPaperHitTarget.style.top = `${metrics.y - metrics.height / 2 - padding}px`;
        riverPaperHitTarget.style.width = `${metrics.width + padding * 2}px`;
        riverPaperHitTarget.style.height = `${metrics.height + padding * 2}px`;
      }

      // A restrained contact darkening anchors the paper on the water without a drop shadow.
      context.save();
      context.translate(metrics.x, metrics.y + metrics.height * .43);
      context.rotate(metrics.rotation);
      context.filter = 'blur(4px)'; context.fillStyle = `rgba(72,61,49,${.055 * (1 - metrics.submersion * .72)})`;
      context.beginPath(); context.ellipse(0, 0, metrics.width * .46, Math.max(3, metrics.height * .115), 0, 0, Math.PI * 2); context.fill();
      context.restore();

      // One quiet ink bloom carries the words into the river while the mask rises.
      const inkElapsed = riverPaperPhase === 'OCCLUDING' ? time - riverPaperOcclusionAt - 120 : -1;
      if (inkElapsed >= 0 && inkElapsed < 1200) {
        const progress = inkElapsed / 1200;
        context.save();
        context.translate(metrics.x, metrics.y + metrics.height * .36);
        context.rotate(metrics.rotation);
        context.scale(.74 + progress * .44, .66 + progress * .24);
        context.filter = 'blur(7px)';
        const ink = context.createRadialGradient(0, 0, 0, 0, 0, metrics.width * .3);
        ink.addColorStop(0, `rgba(85,68,54,${Math.sin(progress * Math.PI) * .12})`);
        ink.addColorStop(.65, `rgba(101,79,60,${Math.sin(progress * Math.PI) * .045})`);
        ink.addColorStop(1, 'rgba(101,79,60,0)');
        context.fillStyle = ink;
        context.beginPath(); context.ellipse(0, 0, metrics.width * .3, Math.max(3, metrics.height * .25), 0, 0, Math.PI * 2); context.fill();
        context.restore();
      }
      // The sole ripple arrives after most of the paper has already slipped below the surface.
      const rippleElapsed = riverPaperPhase === 'OCCLUDING' ? time - riverPaperOcclusionAt - 1050 : -1;
      if (rippleElapsed >= 0 && rippleElapsed < 1400) {
        const progress = rippleElapsed / 1400;
        context.save();
        context.translate(metrics.x, metrics.y + metrics.height * .46);
        context.rotate(metrics.rotation);
        context.scale(1 + progress * .55, 1 + progress * .16);
        context.strokeStyle = `rgba(213,183,139,${Math.sin(progress * Math.PI) * .15})`;
        context.lineWidth = .8;
        context.beginPath();
        context.ellipse(0, 0, metrics.width * .68, Math.max(3, metrics.height * .18), 0, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }
      context.save();
      context.translate(metrics.x, metrics.y);
      context.rotate(metrics.rotation); context.scale(metrics.scale, metrics.scale);
      context.filter = `blur(${metrics.blur}px)`;
      context.globalAlpha = metrics.opacity;
      context.drawImage(riverPaperComposite, -metrics.width / 2, -metrics.height / 2, metrics.width, metrics.height);
      context.restore();
      riverPaperFrame = requestAnimationFrame(drawRiverPaperCanvas);
    }
    function handleRiverPaperPointer(event) {
      if (riverPaperPhase !== 'WAITING' || riverPaperLocked) return;
      riverPaperLocked = true;
      riverPaperPhase = 'PRESSED';
      riverPaperPressedAt = performance.now();
      if (riverPaperHitTarget) riverPaperHitTarget.classList.remove('is-enabled');
      if (riverPaperHitTarget) riverPaperHitTarget.setAttribute('aria-disabled', 'true');
      clearTimeout(riverPaperHintTimer);
      riverPaperHintTimer = 0;
      riverPaperHintAt = 0;
      AudioController.duck({ river:.105, bamboo:.008 }, 600);
      event.preventDefault();
      // The paper first settles 14px into the river over 850ms; only then does
      // the irregular bottom-up water mask begin to consume it.
      queueAct2(850, () => {
        if (riverPaperPhase !== 'PRESSED') return;
        riverPaperPhase = 'OCCLUDING';
        riverPaperOcclusionAt = performance.now();
        setAct2Phase('INTERACTION1_OCCLUDING');
        AudioController.playOneShot('paper');
        queueAct2(2450, () => {
          if (riverPaperPhase !== 'OCCLUDING') return;
          riverPaperPhase = 'DONE';
          setAct2Phase('INTERACTION1_DONE');
          clearRiverPaperInteraction();
          queueAct2(900, enterPavilionArrival);
        });
      });
    }
    function beginRiverPaperInteraction() {
      if (riverPaperPhase !== 'hidden') return;
      riverPaperPhase = 'revealing';
      riverPaperLocked = false;
      act2Locked = true;
      // The river plate returns to its untransformed reference frame before the
      // canvas samples it, preserving paper-to-water registration.
      act2Scene.classList.add('is-cinematic-interaction-hold');
      const layer = document.createElement('canvas');
      layer.className = 'river-paper-canvas';
      layer.setAttribute('aria-hidden', 'true');
      const hitTarget = document.createElement('button');
      hitTarget.type = 'button';
      hitTarget.className = 'river-paper-hit-target';
      hitTarget.setAttribute('aria-label', '触碰漂来的信笺');
      hitTarget.addEventListener('pointerup', handleRiverPaperPointer);
      act2Scene.appendChild(layer);
      act2Scene.appendChild(hitTarget);
      riverPaperLayer = layer;
      riverPaperHitTarget = hitTarget;
      riverPaperContext = layer.getContext('2d');
      riverPaperStartedAt = performance.now();
      resizeRiverPaperCanvas();
      if (typeof window.ResizeObserver === 'function') {
        riverPaperResizeObserver = new window.ResizeObserver(resizeRiverPaperCanvas);
        riverPaperResizeObserver.observe(act2Scene);
      } else {
        window.addEventListener('resize', resizeRiverPaperCanvas);
        riverPaperWindowResizeListening = true;
      }
      riverPaperFrame = requestAnimationFrame(drawRiverPaperCanvas);
      queueAct2(700, () => {
        if (riverPaperPhase !== 'revealing' || !riverPaperLayer) return;
        riverPaperPhase = 'WAITING';
        hitTarget.classList.add('is-enabled');
        setAct2Phase('INTERACTION1_WAITING');
      });
    }
    function resetAct2Visuals() {
      act2TimelineToken++;
      clearAct2Timers();
      clearRiverPaperInteraction();
      resetPavilionEnding();
      act2Scene.classList.remove('is-boatman-visible', 'is-next-hook', 'is-drifting', 'is-dissolving-in', 'is-cinematic-text-focus', 'is-cinematic-interaction-hold');
      act2NetPaper.classList.remove('is-visible');
      act2WaterPaper.classList.remove('is-visible', 'is-sailing');
      act2Ripple.classList.remove('is-visible');
      act2ChoiceStage.classList.remove('is-visible', 'is-resolving');
      act2ChoiceStage.querySelectorAll('.act2-choice').forEach(choice => choice.classList.remove('is-selected'));
      act2PaperBoat.classList.remove('is-visible');
      act2PaperLabel.classList.remove('is-visible');
      unmountAct2Narrative();
    }
    function mountPavilionNarrative(lines, stagger = 180) {
      clearElement(pavilionNarrative);
      pavilionNarrative.classList.remove('is-fading');
      lines.forEach((line, index) => {
        const column = document.createElement('span');
        column.className = 'pavilion-column';
        column.textContent = cleanJourneyNarrative(line);
        column.style.setProperty('--pavilion-delay', `${index * stagger}ms`);
        pavilionNarrative.appendChild(column);
      });
      requestAnimationFrame(() => pavilionNarrative.classList.add('is-visible'));
    }
    function appendPavilionNarrativeColumn(line) {
      const column = document.createElement('span');
      column.className = 'pavilion-column';
      column.textContent = cleanJourneyNarrative(line);
      column.style.setProperty('--pavilion-delay', '0ms');
      pavilionNarrative.appendChild(column);
    }
    function unmountPavilionNarrative() {
      pavilionArrival.classList.remove('is-cinematic-text-focus');
      pavilionNarrative.classList.remove('is-visible', 'is-fading');
      clearElement(pavilionNarrative);
    }
    function fadeOutPavilionNarrative(callback, duration = 1000) {
      pavilionNarrative.classList.add('is-fading');
      queueAct2(duration, () => {
        unmountPavilionNarrative();
        if (typeof callback === 'function') callback();
      });
    }
    function resetPavilionEnding() {
      pavilionEndingPhase = 'idle';
      document.body.classList.remove('is-pavilion-ending');
      pavilionEndingTitle.classList.remove('is-visible');
      pavilionEnding.setAttribute('aria-hidden', 'true');
    }
    function beginPavilionEnding() {
      pavilionInteractionPhase = 'ending';
      pavilionEndingPhase = 'SILENT_HOLD_1';
      pavilionArrival.classList.remove('is-cinematic-text-focus', 'is-cinematic-interaction-hold');
      pavilionArrival.classList.add('is-cinematic-ending-still');
      storyState.currentScene = 'act2_pavilion_ending';
      AudioController.setScene('ending', 1300);
      setAct2Phase('FINAL_SILENT_HOLD_1');
      pavilionEnding.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-pavilion-ending');

      queueAct2(1800, () => {
        pavilionEndingPhase = 'ENVIRONMENT_SETTLE';
        setAct2Phase('FINAL_ENVIRONMENT_SETTLE');
        pavilionLanternAnswer.classList.add('is-ending-settle');
        pavilionWaterAffordance.classList.add('is-ending-settle');
        pavilionEndingPhase = 'TITLE_IN';
        setAct2Phase('FINAL_TITLE_IN');
        pavilionEndingTitle.classList.add('is-visible');

        queueAct2(1300, () => {
          pavilionEndingPhase = 'FINAL_IDLE';
          pavilionInteractionPhase = 'final-idle';
          setAct2Phase('FINAL_IDLE');
        });
      });
    }
    function resetPavilionInteraction() {
      pavilionArrival.classList.remove('is-cinematic-text-focus', 'is-cinematic-interaction-hold', 'is-cinematic-ending-still');
      pavilionInteractionPhase = 'clean';
      pavilionInteractionLocked = false;
      pavilionWaterAffordance.classList.remove('is-noticing', 'is-guiding', 'is-responding', 'is-ending-settle');
      pavilionWaterRipple.classList.remove('is-visible');
      pavilionLanternAnswer.classList.remove('is-noticing', 'is-guiding', 'is-visible', 'is-ending-settle');
      pavilionFireflyGuide.classList.remove('is-intro', 'is-waiting', 'is-hovered', 'is-approaching', 'is-fading');
      pavilionReflectionHitTarget.classList.remove('is-enabled');
      pavilionReflectionHitTarget.setAttribute('aria-disabled', 'true');
      pavilionReflectionHint.classList.remove('is-visible');
      clearElement(pavilionReflectionHint);
      unmountPavilionNarrative();
      resetPavilionEnding();
    }
    function showPavilionReflectionHint() {
      if (pavilionInteractionPhase !== 'waiting' || pavilionInteractionLocked) return;
      pavilionReflectionHint.textContent = '轻触萤火';
      requestAnimationFrame(() => pavilionReflectionHint.classList.add('is-visible'));
    }
    function finishPavilionNarrative() {
      setAct2Phase('PAVILION_NARRATIVE_OUT');
      fadeOutPavilionNarrative(() => {
        pavilionWaterAffordance.classList.remove('is-noticing', 'is-guiding', 'is-responding');
        pavilionWaterRipple.classList.remove('is-visible');
        pavilionLanternAnswer.classList.remove('is-noticing', 'is-guiding', 'is-visible');
        pavilionFireflyGuide.classList.remove('is-intro', 'is-waiting', 'is-hovered', 'is-approaching', 'is-fading');
        pavilionReflectionHint.classList.remove('is-visible');
        clearElement(pavilionReflectionHint);
        beginPavilionEnding();
      }, 1000);
    }
    function beginPavilionNarrativeResponse() {
      storyState.currentScene = 'act2_pavilion_narrative';
      pavilionInteractionPhase = 'narrative';
      pavilionArrival.classList.add('is-cinematic-text-focus');
      setAct2Phase('PAVILION_NARRATIVE');
      clearElement(pavilionNarrative);
      pavilionNarrative.classList.remove('is-fading');
      appendPavilionNarrativeColumn('亭里的杯盏轻轻一响');
      requestAnimationFrame(() => pavilionNarrative.classList.add('is-visible'));

      // Let the first line finish its 900ms entrance, then give it a full quiet
      // second alone before the second column joins it.
      queueAct2(1900, () => {
        appendPavilionNarrativeColumn('有人抬头望向江面');
        queueAct2(900, () => {
          setAct2Phase('PAVILION_NARRATIVE_HOLD');
          queueAct2(5800, finishPavilionNarrative);
        });
      });
    }
    function handlePavilionFireflyPointer(event) {
      if (pavilionInteractionPhase !== 'waiting' || pavilionInteractionLocked) return;
      pavilionInteractionLocked = true;
      pavilionInteractionPhase = 'responding';
      pavilionReflectionHitTarget.classList.remove('is-enabled');
      pavilionReflectionHitTarget.setAttribute('aria-disabled', 'true');
      event.preventDefault();
      pavilionReflectionHint.classList.remove('is-visible');
      queueAct2(350, () => clearElement(pavilionReflectionHint));
      pavilionFireflyGuide.classList.remove('is-intro', 'is-waiting', 'is-hovered');
      pavilionFireflyGuide.classList.add('is-approaching');
      queueAct2(pavilionFireflyApproachMs, () => {
        pavilionFireflyGuide.classList.remove('is-approaching');
        pavilionFireflyGuide.classList.add('is-fading');
        queueAct2(420, () => pavilionFireflyGuide.classList.remove('is-fading'));
      });
      pavilionWaterAffordance.classList.remove('is-noticing', 'is-guiding');
      pavilionLanternAnswer.classList.remove('is-noticing', 'is-guiding');
      setAct2Phase('PAVILION_WATER_RESPONDING');
      // The lantern only answers after the firefly has crossed into its light.
      queueAct2(pavilionFireflyApproachMs, () => {
        pavilionLanternAnswer.classList.add('is-visible');
        AudioController.playOneShot('firefly');
      });
      queueAct2(pavilionFireflyApproachMs + 70, () => {
        pavilionWaterAffordance.classList.add('is-responding');
        pavilionWaterRipple.classList.add('is-visible');
      });
      // Wait until the 1400ms water response is complete, then leave one quiet beat.
      const narrativeDelay = pavilionFireflyApproachMs + 70 + 1400 + 900;
      queueAct2(narrativeDelay - 260, () => {
        AudioController.duck({ river:.095, bamboo:0 }, 700);
        AudioController.playOneShot('cup');
      });
      queueAct2(narrativeDelay, beginPavilionNarrativeResponse);
    }
    function beginPavilionFireflyInteraction() {
      if (pavilionInteractionPhase !== 'clean') return;
      pavilionInteractionPhase = 'guiding';
      // The cue is the only motion that matters while the player is discovering it.
      pavilionArrival.classList.add('is-cinematic-interaction-hold');
      setAct2Phase('PAVILION_FIREFLY_GUIDING');
      pavilionFireflyGuide.classList.add('is-intro');
      // The pavilion is only interactive after the firefly has completed its three
      // readable movement phrases and settled beside the exterior lantern light.
      queueAct2(pavilionFireflyFadeMs + pavilionFireflyPathMs, () => {
        if (pavilionInteractionPhase !== 'guiding' || pavilionInteractionLocked) return;
        pavilionFireflyGuide.classList.remove('is-intro');
        pavilionFireflyGuide.classList.add('is-waiting');
        pavilionInteractionPhase = 'waiting';
        setAct2Phase('PAVILION_WAITING');
        pavilionReflectionHitTarget.classList.add('is-enabled');
        pavilionReflectionHitTarget.setAttribute('aria-disabled', 'false');
        // Text is a fallback only, after the firefly has had 3.6 seconds to guide attention.
        queueAct2(3600, showPavilionReflectionHint);
      });
    }
    function enterPavilionArrival() {
      setAct2Phase('RIVER_TO_PAVILION');
      act2Locked = true;
      AudioController.setScene('pavilionArrival', 1500);
      resetPavilionInteraction();
      pavilionArrival.classList.add('active');
      requestAnimationFrame(() => pavilionArrival.classList.add('is-dissolving-in'));
      act2Scene.classList.add('is-river-dissolve-out');
      queueAct2(1600, () => {
        act2Scene.classList.remove('active', 'is-visible', 'is-river-dissolve-out');
        pavilionArrival.classList.remove('is-dissolving-in');
        pavilionArrival.classList.add('is-visible');
        page = 'pavilionArrival';
        storyState.currentScene = 'act2_pavilion_clean_hold';
        setAct2Phase('PAVILION_CLEAN_HOLD');
        queueAct2(1050, beginPavilionFireflyInteraction);
      });
    }
    function beginDeliveryRiver() {
      setAct2Phase('RIVER_CLEAN_HOLD');
      act2Locked = true;
      queueAct2(420, () => AudioController.playOneShot('boat'));
      queueAct2(1000, () => {
        setAct2Phase('RIVER_DELIVERY_TEXT_IN');
        act2Scene.classList.add('is-drifting');
        mountAct2Narrative(['江水替你', '把话带到了'], 550);
        queueAct2(1450, () => {
          setAct2Phase('RIVER_DELIVERY_TEXT_HOLD');
          queueAct2(5200, () => {
            setAct2Phase('RIVER_DELIVERY_TEXT_OUT');
            fadeOutAct2Narrative(() => {
              setAct2Phase('RIVER_APPROACH');
              queueAct2(1000, beginRiverPaperInteraction);
            }, 1000);
          });
        });
      });
    }
    function beginDeliveryFromWeave() {
      resetAct2Visuals();
      AudioController.setScene('act2', 1200);
      storyState.currentAct = 2;
      storyState.currentScene = 'act2_river_delivery';
      storyState.currentBeat = 0;
      setAct2Phase('RIVER_DISSOLVE_IN');
      act2Locked = true;
      const weaveScene = document.getElementById('weave');
      act2Scene.classList.add('active');
      requestAnimationFrame(() => act2Scene.classList.add('is-dissolving-in'));
      queueAct2(1500, () => {
        weaveScene.classList.remove('active');
        act2Scene.classList.remove('is-dissolving-in');
        act2Scene.classList.add('is-visible');
        page = 'act2';
        beginDeliveryRiver();
      });
    }
    function startDestinationEvent() {
      const destination = storyState.destinationChoice;
      const object = destination === 'net' ? act2NetPaper : act2WaterPaper;
      setAct2Phase(destination === 'net' ? 'ACT2_NET_PAPER_IN' : 'ACT2_WATER_PAPER_IN');
      act2Locked = true;
      object.classList.add('is-visible');
      act2Ripple.classList.remove('is-visible');
      queueAct2(900, () => {
        setAct2Phase(destination === 'net' ? 'ACT2_NET_TEXT' : 'ACT2_WATER_TEXT');
        act2Ripple.classList.add('is-visible');
        mountAct2Narrative(act2Branches[destination][0], 180);
        queueAct2(880, () => {
          queueAct2(1200, () => {
            fadeOutAct2Narrative(() => {
              if (destination === 'net') {
                setAct2Phase('ACT2_NET_CHOICE');
                queueAct2(200, () => {
                  act2ChoiceStage.classList.add('is-visible');
                  act2Locked = false;
                });
              } else {
                continueWaterEvent();
              }
            });
          });
        });
      });
    }
    function continueWaterEvent() {
      setAct2Phase('ACT2_WATER_CONTINUE');
      act2Locked = true;
      queueAct2(900, () => {
        mountAct2Narrative(act2Branches.water[1], 180);
        queueAct2(880, () => {
          queueAct2(1200, () => {
            fadeOutAct2Narrative(() => {
              act2WaterPaper.classList.add('is-sailing');
              queueAct2(1700, mergeAct2Branches);
            });
          });
        });
      });
    }
    function mergeAct2Branches() {
      act2Locked = true;
      act2Phase = 'merging';
      clearAct2Narrative();
      act2ChoiceStage.classList.remove('is-visible', 'is-resolving');
      act2NetPaper.classList.remove('is-visible');
      act2WaterPaper.classList.remove('is-visible', 'is-sailing');
      act2Ripple.classList.remove('is-visible');
      window.setTimeout(() => {
        storyState.currentScene = 'act2_paper_boat';
        storyState.currentBeat = 0;
        act2PaperBoat.classList.add('is-visible');
        act2PaperLabel.classList.add('is-visible');
        act2Phase = 'paper-boat';
        act2Locked = false;
      }, 900);
    }
    function resolveNetAction(action, selectedButton) {
      if (act2Locked || act2Phase !== 'ACT2_NET_CHOICE') return;
      act2Locked = true;
      storyState.netAction = action;
      storyState.currentScene = 'act2_net_action';
      setAct2Phase('ACT2_NET_ACTION');
      selectedButton.classList.add('is-selected');
      act2ChoiceStage.classList.add('is-resolving');
      queueAct2(500, () => {
        act2ChoiceStage.classList.remove('is-visible');
        mountAct2Narrative(action === 'retrieve' ? ['碎纸贴在掌心', '还带着一点水'] : ['碎纸又回到水里', '顺着篙影漂远了'], 180);
        queueAct2(880, () => {
          queueAct2(1200, () => fadeOutAct2Narrative(() => queueAct2(700, mergeAct2Branches)));
        });
      });
    }
    function revealOriginCallback() {
      if (act2Locked || act2Phase !== 'paper-boat') return;
      act2Locked = true;
      act2PaperBoat.classList.remove('is-visible');
      act2PaperLabel.classList.remove('is-visible');
      storyState.currentScene = 'act2_origin_callback';
      storyState.currentBeat = 1;
      renderAct2Narrative(originCallbacks[storyState.originChoice]);
      act2Phase = 'origin-callback';
      window.setTimeout(() => {
        clearAct2Narrative();
        storyState.currentScene = 'act2_next';
        storyState.currentBeat = 0;
        act2Scene.classList.add('is-next-hook');
        act2Phase = 'next-hook';
        act2Locked = false;
      }, 2900);
    }
    document.querySelectorAll('#act2 .act2-choice').forEach(choice => choice.addEventListener('click', () => resolveNetAction(choice.dataset.netAction, choice)));
    act2PaperBoat.addEventListener('click', revealOriginCallback);
    pavilionReflectionHitTarget.addEventListener('pointerup', handlePavilionFireflyPointer);
    pavilionReflectionHitTarget.addEventListener('pointerenter', () => pavilionFireflyGuide.classList.add('is-hovered'));
    pavilionReflectionHitTarget.addEventListener('pointerleave', () => pavilionFireflyGuide.classList.remove('is-hovered'));
    const audioToggle = document.getElementById('audioToggle');
    audioToggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      AudioController.unlock();
      const muted = AudioController.setMuted(audioToggle.getAttribute('aria-pressed') !== 'true');
      audioToggle.setAttribute('aria-pressed', String(muted));
      audioToggle.setAttribute('aria-label', muted ? '取消静音' : '静音');
      audioToggle.textContent = muted ? '静' : '声';
    });
    window.addEventListener('load', typeWriter);
