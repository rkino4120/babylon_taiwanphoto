import { useEffect, useRef } from 'react';
import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  Color3,
  Color4,
  HemisphericLight,
  SpotLight,
  MeshBuilder,
  StandardMaterial,
  Texture,
  Animation,
  CubicEase,
  Mesh,
  PointerEventTypes,
  DynamicTexture,
} from '@babylonjs/core';
import { Sound } from '@babylonjs/core/Audio/sound';
// AudioEngineV2 is available; Babylon Sound will be used for spatial audio

// --- 型定義 ---
interface MicroCMSImage {
  url: string;
  height: number;
  width: number;
}

interface WorkItem {
  id: string;
  title?: string;
  body?: string;
  shootingdate?: string;
  photo: MicroCMSImage;
}

interface MicroCMSResponse {
  contents: WorkItem[];
  totalCount: number;
  offset: number;
  limit: number;
}

// アプリケーション内で保持する写真エントリの型
interface PhotoEntry {
  photoPlane: Mesh;
  mat: StandardMaterial;
  whiteFramePlane: Mesh;
  blackFramePlane: Mesh;
  textPlane: Mesh;
  textMat: StandardMaterial; // テキスト用マテリアル
  textTexture: DynamicTexture; // GUIの代わりにDynamicTextureを保持
  originalZ: number;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // --- 初期化 ---
    const engine = new Engine(canvasRef.current, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    // パフォーマンス最適化フラグ
    scene.autoClear = true; // 毎フレーム背景を黒でクリア
    scene.autoClearDepthAndStencil = true;
    scene.blockMaterialDirtyMechanism = true; // マテリアル変更を手動管理
    scene.skipFrustumClipping = false; // カリングは有効のまま

    // Using Babylon Sound (AudioEngineV2) for spatial audio

    // カメラ（ブラウザ表示用 - 固定位置、操作無効）
    const camera = new ArcRotateCamera(
      'camera',
      -Math.PI / 2,
      Math.PI / 2.5,
      2,
      new Vector3(-1.5, 1.6, 0), // VRと同じ初期位置
      scene
    );
    // 90度（π/2）回転
    camera.alpha += Math.PI / 2;
    // ブラウザでのカメラ移動を禁止（VR初期位置を固定するため）
    // camera.attachControl(canvasRef.current, true); // 無効化
    camera.minZ = 0.1;

    // 環境光
    const ambientLight = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
    ambientLight.intensity = 0.1;

    // スポットライト
    const spotLightPositions = [
      new Vector3(-2.5, 4, 0),
      new Vector3(0, 4, 0),
      new Vector3(2.5, 4, 0),
    ];

    spotLightPositions.forEach((position, index) => {
      const spotLight = new SpotLight(
        `spotLight${index}`,
        position,
        new Vector3(0, -1, 0),
        Math.PI / 3,
        50,
        scene
      );
      spotLight.intensity = 2.0;
      spotLight.innerAngle = Math.PI / 8;
    });

    // --- 変数管理 ---
    let photoEntries: Array<PhotoEntry | null> = [null, null, null];
    let pageOffset = 0;
    let totalCount = 0;
    // ページスライドの非同期処理キュー（競合回避）
    let slideQueue: Promise<void> = Promise.resolve();
    // BGM 用（Babylon Sound）
    let bgmSound: Sound | null = null;
    let bgmAudio: HTMLAudioElement | null = null;
    let bgmPlaying = false;
    let bgmSoundIsFromAudioElement = false;
    let wasBgmAudioPlayingBeforeXr = false;
    // XR / VR camera handling
    let xrBaseExperience: any = null;
    let xrCamera: any = null;
    let isInXR = false;
    let xrRecentered = false; // whether we've applied world recentering for XR

    // Loading overlay / progress
    let totalAssets = 0;
    let loadedAssets = 0;
    let loadingOverlay: HTMLDivElement | null = null;
    let loadingTextDiv: HTMLDivElement | null = null;
    let loadingBarInner: HTMLDivElement | null = null;
    // no pending list UI in production mode
    let loadingOverlayShownAt = 0;
    const loadingOverlayMinMs = 300;
    const registeredAssetKeys = new Set<string>();
    const registeredAssetDone = new Set<string>();
    // registeredAssetStatus/timeouts removed in production build
    const TEXT_SCALE = 2;

    const createLoadingOverlay = () => {
      if (loadingOverlay) return;
      // Note: session reset handled by registerAsset when starting a new session
      loadingOverlay = document.createElement('div');
      loadingOverlay.id = 'app-loading-overlay';
      const s = loadingOverlay.style;
      s.position = 'fixed';
      s.left = '0';
      s.top = '0';
      s.width = '100%';
      s.height = '100%';
      s.display = 'flex';
      s.flexDirection = 'column';
      s.justifyContent = 'center';
      s.alignItems = 'center';
      s.backgroundColor = 'rgba(0,0,0,0.8)';
      s.zIndex = '100000';
      s.color = 'white';

      loadingTextDiv = document.createElement('div');
      loadingTextDiv.style.fontSize = '18px';
      loadingTextDiv.style.marginBottom = '10px';
      loadingTextDiv.textContent = 'あと 100%';
      loadingOverlay.appendChild(loadingTextDiv);
      // pending list UI removed for a cleaner UI

      const bar = document.createElement('div');
      bar.style.width = '60%';
      bar.style.height = '8px';
      bar.style.backgroundColor = '#444';
      bar.style.borderRadius = '8px';
      bar.style.overflow = 'hidden';
      const inner = document.createElement('div');
      inner.style.width = '0%';
      inner.style.height = '100%';
      inner.style.backgroundColor = '#1db954';
      inner.style.transition = 'width 200ms linear';
      bar.appendChild(inner);
      loadingBarInner = inner;
      loadingOverlay.appendChild(bar);

      document.body.appendChild(loadingOverlay);
      loadingOverlayShownAt = Date.now();
    };

    // Track progress for stuck detection
    let lastLoadedAssets = 0;
    let lastLoadedUpdateAt = Date.now();

    const updateLoadingOverlay = () => {
      if (!loadingTextDiv || !loadingBarInner) return;
      const percent = totalAssets === 0 ? 0 : Math.round((loadedAssets / totalAssets) * 100);
      const remaining = 100 - percent;
      loadingTextDiv.textContent = `あと ${remaining}%`; // Japanese: "remaining %"
      loadingBarInner.style.width = `${percent}%`;
      // DEV mode: log current status
      if (import.meta.env.DEV) {
        console.debug(`[loading] ${loadedAssets}/${totalAssets} (${percent}%)`);
      }
      // no debug UI, but log stalled pending assets if stuck
      try {
        if (totalAssets > 0 && loadedAssets < totalAssets) {
          if (loadedAssets !== lastLoadedAssets) {
            lastLoadedAssets = loadedAssets;
            lastLoadedUpdateAt = Date.now();
          } else {
            const elapsed = Date.now() - lastLoadedUpdateAt;
            if (elapsed > 3000) { // 3s without progress
              const pending = Array.from(registeredAssetKeys).filter(k => !registeredAssetDone.has(k));
              console.warn('[loading] No progress for 3s; pending assets:', pending.slice(0, 50));
              lastLoadedUpdateAt = Date.now(); // avoid spamming
            }
          }
        }
      } catch (e) { /* ignore */ }
      if (totalAssets > 0 && loadedAssets >= totalAssets) {
        // hide overlay after short delay
        const hideNow = () => {
          if (loadingOverlay && loadingOverlay.parentElement) {
            try { loadingOverlay.parentElement.removeChild(loadingOverlay); } catch (e) { /* ignore */ }
          }
          loadingOverlay = null;
          loadingTextDiv = null;
          loadingBarInner = null;
          loadingOverlayShownAt = 0;
        };
        const elapsed = Date.now() - (loadingOverlayShownAt || 0);
        const waitMs = Math.max(0, (loadingOverlayMinMs || 0) - elapsed);
        setTimeout(hideNow, waitMs + 220);
      }
    };

    const registerAsset = (key?: string) => {
      // If this is the first asset of a (new) loading session, initialize counters
      const isNewSession = !loadingOverlay;
      if (isNewSession) {
        registeredAssetKeys.clear();
        totalAssets = 0;
        loadedAssets = 0;
      }

      // Provide a stable key if none passed
      const k = key || `asset:${Math.random().toString(36).slice(2)}`;
      // If already registered, no-op to avoid double count
      if (registeredAssetKeys.has(k)) {
        createLoadingOverlay();
        updateLoadingOverlay();
        return () => {};
      }
      registeredAssetKeys.add(k);
      totalAssets++;
      // show overlay when first asset is registered
      createLoadingOverlay();
      updateLoadingOverlay();
      
      if (import.meta.env.DEV) {
        console.debug('[registerAsset] register', k);
      }
      
      return () => {
        loadedAssets++;
        registeredAssetDone.add(k);
        // track last loaded time for stuck detection
        lastLoadedAssets = loadedAssets;
        lastLoadedUpdateAt = Date.now();
        
        if (import.meta.env.DEV) {
          console.debug('[registerAsset] done', k);
        }
        
        updateLoadingOverlay();
      };
    };

    // registerPromise helper removed (unused) - use registerAsset directly for promises if needed

    const registerImage = (img: HTMLImageElement, key?: string) => {
      const k = key || img?.src || `img:${Math.random().toString(36).slice(2)}`;
      const done = registerAsset(k);
      const onLoad = () => { done(); cleanup(); };
      const onError = () => { done(); cleanup(); };
      const cleanup = () => { img.removeEventListener('load', onLoad); img.removeEventListener('error', onError); };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    };

    const registerTexture = (tex: Texture, key?: string) => {
      // Texture.name often holds the url passed in; fallback to random key
      const k = key || (tex as any).name || (tex as any).url || `tex:${Math.random().toString(36).slice(2)}`;
      const done = registerAsset(k);
      try {
        // Babylon's Texture has onLoadObservable/onErrorObservable
        if ((tex as any).onLoadObservable && typeof (tex as any).onLoadObservable.addOnce === 'function') {
          (tex as any).onLoadObservable.addOnce(() => done());
        } else {
          // fallback: mark loaded quickly
          done();
        }
      } catch (e) {
        done();
      }
    };

    // Spatial audio tuning parameters
    const spatialConfig = {
      room: { width: 10, height: 3, depth: 10 },
      roomReflection: { left: 0.2, right: 0.2, front: 0.15, back: 0.15, up: 0.05, down: 0.05 },
      reverb: { gain: 0.25, duration: 1.8 },
      source: { gain: 1.0, directivityAlpha: 0.0, directivitySharpness: 0.7 },
      panner: { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 0.8, maxDistance: 40, rolloffFactor: 1.1, coneInnerAngle: 60, coneOuterAngle: 120, coneOuterGain: 0.2 }
    };

    // BGM 再生/一時停止トグル
    // initAudioEngine(): Babylon Sound を利用するための初期化は不要（Sound が scene に依存します）
    // initAudioEngine not required; Babylon Sound creates and manages audio context

    const toggleBgm = async () => {
      if (!bgmSound && !bgmAudio) {
        console.log('toggleBgm: BGM not ready');
        return;
      }

      // Decide which backend to use: prefer non-spatial audio (bgmAudio) on desktop/non-XR
      const useSpatial = !!(isInXR && bgmSound); // if in XR and bgmSound exists, use spatial

      if (bgmPlaying) {
        try {
          if (useSpatial && bgmSound) {
            try { bgmSound.pause(); } catch (e) { /* ignore */ }
            console.log('BGM paused (Babylon Sound)');
          } else if (bgmAudio) {
            try { bgmAudio.pause(); } catch (e) { /* ignore */ }
            console.log('BGM paused (HTMLAudioElement)');
          }
          bgmPlaying = false;
          console.log('BGM paused overall');
        } catch (e) {
          console.warn('toggleBgm: pause failed', e);
        }
      } else {
        try {
          // attempt to resume audio engine/context (some browsers require user interaction)
          try {
            const audioEngine = (scene as any)?.getEngine?.()?.audioEngine;
            if (audioEngine) {
              // Prefer the v2 API: unlockAsync -> resumeAsync -> (fallback) resume
              if (typeof (audioEngine as any).unlockAsync === 'function') {
                try { await (audioEngine as any).unlockAsync(); } catch (e) { /* ignore */ }
              } else if (typeof (audioEngine as any).resumeAsync === 'function') {
                try { await (audioEngine as any).resumeAsync(); } catch (e) { /* ignore */ }
              } else if (typeof (audioEngine as any).resume === 'function') {
                try { await (audioEngine as any).resume(); } catch (e) { /* ignore */ }
              }
            } else if ((window as any).audioContext && (window as any).audioContext.state === 'suspended') {
              try { await (window as any).audioContext.resume(); } catch (e) { /* ignore */ }
            }
          } catch (ee) { /* ignore */ }

          if (useSpatial && bgmSound) {
            console.log('toggleBgm: attempting Babylon Sound play');
            await bgmSound.play();
            console.log('BGM playing (Babylon Sound)');
          } else if (bgmAudio) {
            console.log('toggleBgm: attempting HTMLAudioElement play');
            try { await bgmAudio.play(); } catch (e) { console.warn('bgmAudio.play() error', e); throw e; }
            console.log('BGM playing (HTMLAudioElement)');
          }
          bgmPlaying = true;
        } catch (e) {
          console.warn('toggleBgm: play failed, attempting fallback', e);
          // fallback: try to create / start HTMLAudioElement and attach to Babylon Sound if in XR
          try {
            if (!bgmAudio) {
              const a = new Audio('/sound/bgm.mp3');
              a.crossOrigin = 'anonymous';
              a.loop = true;
              a.volume = 0.5;
              try { a.load(); } catch (ee) { /* ignore */ }
              bgmAudio = a;
            }
            try { await bgmAudio.play(); bgmPlaying = true; console.log('BGM playing (fallback to HTMLAudioElement)'); } catch (ee) { console.warn('toggleBgm: HTMLAudioElement fallback failed', ee); }

            // If in XR, create a Babylon Sound from the DOM element and attach for spatial audio
            if (isInXR && bgmAudio && !bgmSound) {
              try {
                const domSound = new Sound('bgm', bgmAudio, scene, () => { console.log('[XR] Babylon Sound created from fallback HTMLAudioElement'); }, { loop: true, spatialSound: true, autoplay: false, volume: bgmAudio?.volume ?? 0.5 });
                bgmSound = domSound;
                bgmSoundIsFromAudioElement = true;
                try { const fp = scene.getMeshByName('frontpage'); if (fp) { bgmSound.attachToMesh(fp); console.log('[XR] attached fallback-created bgmSound to frontpage'); } } catch (ex) { /* ignore */ }
                // Hand off: pause DOM element and start Babylon Sound
                try { if (!bgmAudio.paused) { bgmAudio.pause(); await bgmSound.play(); console.log('[XR] swapped fallback HTMLAudioElement to Babylon Sound'); } } catch (ex) { console.warn('[XR] failed to handoff fallback to Babylon Sound', ex); }
              } catch (ex) { console.warn('[XR] failed to create Babylon Sound from fallback HTMLAudioElement', ex); }
            }
          } catch (ee) { console.warn('toggleBgm: fallback attempts failed', ee); }
        }
      }
    }; 

    // --- 床・壁の作成 ---
    const ground = MeshBuilder.CreateGround('ground', { width: 10, height: 10 }, scene);
    const groundMaterial = new StandardMaterial('groundMaterial', scene);
    const diffuseTexture = new Texture('/images/concrete_floor_worn_001_diff_1k.jpg', scene);
    try { registerTexture(diffuseTexture, 'images/concrete_floor_worn_001_diff_1k.jpg'); } catch (e) { /* ignore */ }
    diffuseTexture.uScale = 5;
    diffuseTexture.vScale = 5;
    groundMaterial.diffuseTexture = diffuseTexture;
    const bumpTexture = new Texture('/images/concrete_floor_worn_001_nor_gl_1k.png', scene);
    try { registerTexture(bumpTexture, 'images/concrete_floor_worn_001_nor_gl_1k.png'); } catch (e) { /* ignore */ }
    bumpTexture.uScale = 5;
    bumpTexture.vScale = 5;
    groundMaterial.bumpTexture = bumpTexture;
    groundMaterial.useParallax = true;
    groundMaterial.useParallaxOcclusion = true;
    groundMaterial.parallaxScaleBias = 0.1;
    groundMaterial.specularPower = 32;
    groundMaterial.freeze(); // マテリアルを固定してシェーダー再コンパイルを防ぐ
    ground.material = groundMaterial;
    ground.freezeWorldMatrix(); // 静的メッシュのワールド行列を固定

    // 矢印ボタン
    const arrowTex = new Texture('/images/arrow.png', scene);
    try { registerTexture(arrowTex, 'images/arrow.png'); } catch (e) { /* ignore */ }
    arrowTex.hasAlpha = true;
    const arrowMat = new StandardMaterial('arrowMat', scene);
    arrowMat.diffuseTexture = arrowTex;
    arrowMat.emissiveTexture = arrowTex;
    arrowMat.useAlphaFromDiffuseTexture = true;
    arrowMat.disableLighting = true;
    arrowMat.backFaceCulling = false;
    arrowMat.freeze();

    const arrowImg = new Image();
    try { registerImage(arrowImg, 'images/arrow.png'); } catch (e) { /* ignore */ }
    arrowImg.onload = () => {
      if (scene.isDisposed) return;
      const iw = arrowImg.naturalWidth || 1;
      const ih = arrowImg.naturalHeight || 1;
      const aspect = iw / ih;
      const size = 0.8;
      let aw: number, ah: number;
      if (aspect >= 1) {
        aw = size;
        ah = size / aspect;
      } else {
        ah = size;
        aw = size * aspect;
      }

      const arrow1 = MeshBuilder.CreatePlane('groundArrow1', { width: aw, height: ah }, scene);
      arrow1.position = new Vector3(-2, 0.05, 0);
      arrow1.rotation.x = Math.PI / 2;
      arrow1.material = arrowMat;
      arrow1.isPickable = true;

      const arrow2 = MeshBuilder.CreatePlane('groundArrow2', { width: aw, height: ah }, scene);
      arrow2.position = new Vector3(2, 0.05, 0);
      arrow2.rotation.x = Math.PI / 2;
      arrow2.rotation.z = Math.PI;
      arrow2.material = arrowMat;
      arrow2.isPickable = true;
      // If we're already in XR, recenter the XR rig so the arrows are centered
      try { maybeCenterXR(); } catch (e) { /* ignore */ }
    };
    arrowImg.src = '/images/arrow.png';

    // if we are already in XR, ensure the scene is centered between arrows after arrows are created
    const maybeCenterXR = () => {
      try {
        if (!isInXR || !xrBaseExperience || xrRecentered) return;
        const a1 = scene.getMeshByName('groundArrow1') as Mesh | null;
        const a2 = scene.getMeshByName('groundArrow2') as Mesh | null;
        if (!a1 || !a2) return;
        const p1 = a1.getAbsolutePosition();
        const p2 = a2.getAbsolutePosition();
        const centerX = (p1.x + p2.x) / 2;
        const centerZ = (p1.z + p2.z) / 2;
        const rigParent = (xrBaseExperience && xrBaseExperience.camera) ? (xrBaseExperience.camera as any).rigParent : null;
        if (rigParent) {
          try { rigParent.position = new Vector3(-centerX, 0, -centerZ); xrRecentered = true; console.log('[XR] recentred on arrow center via rigParent', centerX, centerZ);} catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    };

    // 壁マテリアル
    const wallMaterial = new StandardMaterial('wallMaterial', scene);
    wallMaterial.backFaceCulling = false;
    const wallDiffuseTexture = new Texture('/images/painted_plaster_wall_diff_1k.jpg', scene);
    try { registerTexture(wallDiffuseTexture, 'images/painted_plaster_wall_diff_1k.jpg'); } catch (e) { /* ignore */ }
    wallDiffuseTexture.uScale = 5;
    wallDiffuseTexture.vScale = 2;
    wallMaterial.diffuseTexture = wallDiffuseTexture;
    const wallBumpTexture = new Texture('/images/painted_plaster_wall_nor_gl_1k.png', scene);
    try { registerTexture(wallBumpTexture, 'images/painted_plaster_wall_nor_gl_1k.png'); } catch (e) { /* ignore */ }
    wallBumpTexture.uScale = 5;
    wallBumpTexture.vScale = 2;
    wallMaterial.bumpTexture = wallBumpTexture;
    wallMaterial.freeze();

    const wall1 = MeshBuilder.CreatePlane('wall1', { width: 10, height: 4 }, scene);
    wall1.position = new Vector3(0, 2, -0.9);
    wall1.rotation.y = Math.PI;
    wall1.material = wallMaterial;
    wall1.freezeWorldMatrix();

    const wall2 = MeshBuilder.CreatePlane('wall2', { width: 10, height: 4 }, scene);
    wall2.position = new Vector3(0, 2, 0.9);
    wall2.rotation.y = 0;
    wall2.material = wallMaterial;
    wall2.freezeWorldMatrix();

    // GLBファイルの読み込みは無効化されています


    // BGM は frontPlane 作成後に空間化してアタッチするためここでは作成しない

    // frontpage / profilepage を wall2 の前面に上下に配置
    // 上: frontpage, 下: profilepage
      const frontMat = new StandardMaterial('frontpageMat', scene);
      frontMat.disableLighting = true;
      frontMat.backFaceCulling = false;

      const profileMat = new StandardMaterial('profilepageMat', scene);
      profileMat.disableLighting = true;
      profileMat.backFaceCulling = false;

      // frontpage: 画像を読み込んでアスペクト比に基づきリサイズ（高さ基準）
      const frontImg = new Image();
      try { registerImage(frontImg, 'images/frontpage.jpg'); } catch (e) { /* ignore */ }
      let frontLoaded = false;
      frontImg.onload = async () => {
        if (frontLoaded || scene.isDisposed) return;
        frontLoaded = true;
        const iw = frontImg.naturalWidth || 1;
        const ih = frontImg.naturalHeight || 1;
        const aspect = iw / ih;
        const targetH = 0.4; // 基準高さ
        const targetW = targetH * aspect;
        console.log('frontImg.onload:', { iw, ih, aspect, targetW, targetH });

        frontMat.diffuseTexture = new Texture('/images/frontpage.jpg', scene);
        try { registerTexture(frontMat.diffuseTexture as Texture, 'images/frontpage.jpg'); } catch (e) { /* ignore */ }
        try { if ((frontMat.diffuseTexture as any).onLoadObservable && typeof (frontMat.diffuseTexture as any).onLoadObservable.addOnce === 'function') {
          (frontMat.diffuseTexture as any).onLoadObservable.addOnce(() => console.log('frontMat diffuse texture onLoadObservable fired'));
        } } catch (e) { /* ignore */ }
        frontMat.emissiveTexture = frontMat.diffuseTexture;

        const frontPlane = MeshBuilder.CreatePlane('frontpage', { width: targetW, height: targetH }, scene);
        frontPlane.position = new Vector3(-1.2, 1.5, 0.89);
        frontPlane.rotation.y = 0;
        frontPlane.material = frontMat;
        // frontPlane をクリック可能にして BGM トグルを割り当てる
        frontPlane.isPickable = true;
        frontPlane.doNotSyncBoundingInfo = true;
        // Ensure plane is enabled and visible
        try { frontPlane.setEnabled(true); } catch (e) { /* ignore */ }
        try { frontPlane.isVisible = true; } catch (e) { /* ignore */ }
        console.log('frontPlane created', { width: targetW, height: targetH });
        try { console.log('frontPlane info', { position: frontPlane.position, isEnabled: frontPlane.isEnabled(), isVisible: (frontPlane as any).isVisible ?? true, absolute: frontPlane.getAbsolutePosition(), materialHasEmissive: !!frontMat.emissiveTexture, emissiveReady: (frontMat.emissiveTexture as any)?.isReady, diffuseReady: (frontMat.diffuseTexture as any)?.isReady }); } catch (e) { console.warn('frontPlane info read failed', e); }
        try { console.log('scene meshes contains frontpage:', !!scene.getMeshByName('frontpage')); } catch (e) { /* ignore */ }
        // Do not freeze frontPlane world matrix: we need live position updates for spatial audio
        frontMat.freeze();

        // ポインタ（クリック / コントローラ選択）を監視して frontPlane をクリックしたらトグル
        scene.onPointerObservable.add((pi) => {
          if (pi.type !== PointerEventTypes.POINTERDOWN) return;
          const pickInfo = pi.pickInfo;
          if (pickInfo && pickInfo.hit && pickInfo.pickedMesh) {
            try {
              const pickedName = (pickInfo.pickedMesh && pickInfo.pickedMesh.name) ? pickInfo.pickedMesh.name : null;
              console.log('[pointer] picked mesh:', pickedName);
              if (pickedName === 'frontpage') {
                console.log('[pointer] frontpage selected; isInXR=', isInXR, 'bgmSound?', !!bgmSound, 'bgmAudio?', !!bgmAudio, 'bgmPlaying?', bgmPlaying);
                toggleBgm();
              }
            } catch (e) { /* ignore */ }
          }
        });

        // BGM をロード（Babylon Sound を利用）
        try {
          // register for loading overlay
          const done = registerAsset('sound/bgm.mp3');
          // create spatial sound and attach to front plane
          try {
            let soundLoaded = false;
            bgmSound = new Sound('bgm', '/sound/bgm.mp3', scene, () => {
              try { done(); } catch (e) { /* ignore */ }
              soundLoaded = true;
              console.log('BGM loaded (Babylon Sound)');
              // ensure HTMLAudioElement fallback is ready for reliable user-initiated playback
              try {
                if (!bgmAudio) {
                  const _audioEl = new Audio('/sound/bgm.mp3');
                  _audioEl.crossOrigin = 'anonymous';
                  _audioEl.loop = true;
                  _audioEl.volume = 0.5;
                  try { _audioEl.load(); } catch (e) { /* ignore */ }
                  bgmAudio = _audioEl;
                }
              } catch (e) { /* ignore */ }
            }, { loop: true, spatialSound: true, autoplay: false, volume: 0.5 });
            // attach to mesh so it moves with it and becomes a positional source
            try { bgmSound.attachToMesh(frontPlane); } catch (e) { /* ignore */ }
            // attempt to tune attenuation if supported
            try { if ((bgmSound as any).setDistanceModel) (bgmSound as any).setDistanceModel(spatialConfig.panner.distanceModel); } catch (e) { /* ignore */ }
            try { if ((bgmSound as any).setMaxDistance) (bgmSound as any).setMaxDistance(spatialConfig.panner.maxDistance); } catch (e) { /* ignore */ }
            // safety fallback: if Babylon sound callback doesn't fire in reasonable time, use HTMLAudioElement fallback
            setTimeout(() => {
              if (!soundLoaded) {
                console.warn('BGM Sound callback not fired — using HTMLAudioElement fallback');
                try { done(); } catch (e) { /* ignore */ }
                try { if (bgmSound) { bgmSound.dispose(); bgmSound = null; } } catch (e) { /* ignore */ }
                // Note: don't use registerAudioElement here as we already called done() above
                if (!bgmAudio) {
                  const audioEl = new Audio('/sound/bgm.mp3');
                  audioEl.crossOrigin = 'anonymous';
                  audioEl.loop = true;
                  audioEl.volume = 0.5;
                  try { audioEl.load(); } catch (e) { /* ignore */ }
                  bgmAudio = audioEl; // store fallback audio for toggle access 
                }
              }
            }, 7000); // 7s fallback
          } catch (e) {
            try { done(); } catch (_) { /* ignore */ }
            console.warn('BGM Sound init failed', e);
            // fallback: HTMLAudioElement (done() already called above)
            try {
              const audioEl = new Audio('/sound/bgm.mp3');
              audioEl.crossOrigin = 'anonymous';
              audioEl.loop = true;
              audioEl.volume = 0.5;
              bgmAudio = audioEl; // store fallback audio for toggle access
              // Note: don't register again, done() already called
            } catch (e2) { /* ignore */ }
            bgmSound = null;
          }
        } catch (e) {
          console.warn('BGM load failed (Babylon Sound)', e);
          bgmSound = null;
        }
      };
      frontImg.onerror = (ev) => { console.error('frontImg.onerror', ev, frontImg.src); };
      frontImg.src = '/images/frontpage.jpg';

      // profilepage: 同上（下側）
      const profileImg = new Image();
      try { registerImage(profileImg, 'images/profilepage.jpg'); } catch (e) { /* ignore */ }
      let profileLoaded = false;
      profileImg.onload = () => {
        if (profileLoaded || scene.isDisposed) return;
        profileLoaded = true;
        const iw = profileImg.naturalWidth || 1;
        const ih = profileImg.naturalHeight || 1;
        const aspect = iw / ih;
        const targetH = 0.4;
        const targetW = targetH * aspect;
        console.log('profileImg.onload:', { iw, ih, aspect, targetW, targetH });

        profileMat.diffuseTexture = new Texture('/images/profilepage.jpg', scene);
        try { registerTexture(profileMat.diffuseTexture as Texture, 'images/profilepage.jpg'); } catch (e) { /* ignore */ }
        try { if ((profileMat.diffuseTexture as any).onLoadObservable && typeof (profileMat.diffuseTexture as any).onLoadObservable.addOnce === 'function') {
          (profileMat.diffuseTexture as any).onLoadObservable.addOnce(() => console.log('profileMat diffuse texture onLoadObservable fired'));
        } } catch (e) { /* ignore */ }
        profileMat.emissiveTexture = profileMat.diffuseTexture;

        const profilePlane = MeshBuilder.CreatePlane('profilepage', { width: targetW, height: targetH }, scene);
        profilePlane.position = new Vector3(-0.8, 1.5, 0.89);
        profilePlane.rotation.y = 0;
        profilePlane.material = profileMat;
        profilePlane.isPickable = false;
        profilePlane.doNotSyncBoundingInfo = true;
        profilePlane.freezeWorldMatrix();
        profileMat.freeze();
      };
      profileImg.onerror = (ev) => { console.error('profileImg.onerror', ev, profileImg.src); };
      profileImg.src = '/images/profilepage.jpg';

    // --- ヘルパー: テキスト描画 ---
    const drawTextOnTexture = (texture: DynamicTexture, title: string, body: string, date: string) => {
      // Render at TEXT_SCALE x resolution for crisper text
      // use global TEXT_SCALE
      const baseWidth = 1024;
      const baseHeight = 410;
      const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
      const width = baseWidth * TEXT_SCALE;
      const height = baseHeight * TEXT_SCALE; // テクスチャサイズ (scaled)
      // Vertical adjustment for text content (px, pre-scale). Negative = move up.
      const CONTENT_Y_OFFSET_PX = -18; // move body/date up slightly
      // try to disable smoothing to reduce blurring where possible
      try { (ctx as any).imageSmoothingEnabled = false; } catch (e) { /* ignore */ }
      try { (ctx as any).webkitImageSmoothingEnabled = false; } catch (e) { /* ignore */ }
      try { (ctx as any).msImageSmoothingEnabled = false; } catch (e) { /* ignore */ }

      // クリア
      ctx.clearRect(0, 0, width, height);

      // タイトル
      ctx.font = `bold ${16 * TEXT_SCALE}px 'Noto Sans JP', sans-serif`;
      ctx.fillStyle = "white";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, Math.round(width / 2), Math.round(80 * TEXT_SCALE));

      // 本文（簡易折り返し + <br> 対応）
      ctx.font = `${10 * TEXT_SCALE}px 'Noto Sans JP', sans-serif`;
      ctx.fillStyle = "white";
      // scale layout values to TEXT_SCALE
      const maxLineWidth = 900 * TEXT_SCALE;
      const lineHeight = 30 * TEXT_SCALE;
      // Apply vertical offset to body start
      let y = (150 + CONTENT_Y_OFFSET_PX) * TEXT_SCALE;

      // HTML 内の <br> を改行に変換してからテキストを取り出す
      const tempDiv = document.createElement('div');
      const withBreaks = (body || '').replace(/<br\s*\/?>/gi, '\n');
      tempDiv.innerHTML = withBreaks;
      const bodyText = tempDiv.textContent || tempDiv.innerText || '';

      // 段落ごとに分割して、文字単位で折り返す（日本語向けの簡易処理）
      const paragraphs = bodyText.split(/\r?\n/);
      paragraphLoop: for (let p = 0; p < paragraphs.length; p++) {
        const para = paragraphs[p] || '';
        const chars = para.split('');
        let line = '';

        for (let n = 0; n < chars.length; n++) {
          const testLine = line + chars[n];
          const testWidth = ctx.measureText(testLine).width;
            if (testWidth > maxLineWidth && n > 0) {
            ctx.fillText(line, Math.round(width / 2), Math.round(y));
            line = chars[n];
            y += lineHeight;
            if (y > 320 * TEXT_SCALE) break paragraphLoop; // テクスチャ高さを超えたら終了
          } else {
            line = testLine;
          }
        }

        // 残りの行を描画
        if (y <= 320 * TEXT_SCALE) {
          ctx.fillText(line, Math.round(width / 2), Math.round(y));
        }

        // 段落間の余白
        y += lineHeight;
        if (y > 320 * TEXT_SCALE) break;
      }

      // 日付（本文と同じオフセットで少し上に表示）
      ctx.font = `${10 * TEXT_SCALE}px 'Noto Sans JP', sans-serif`;
      ctx.fillStyle = "#cccccc";
      ctx.fillText(date, Math.round(width / 2), Math.round((220 + CONTENT_Y_OFFSET_PX) * TEXT_SCALE));

      texture.update();
    };

    // --- 写真作成ロジック ---
    const createOrUpdateEntry = (work: WorkItem, index: number) => {
      if (scene.isDisposed) return;

      // 古いエントリがある場合は破棄して再作成する
      if (photoEntries[index]) {
        const old = photoEntries[index]!;
        old.photoPlane.dispose();
        old.whiteFramePlane.dispose();
        old.blackFramePlane.dispose();
        old.textPlane.dispose();
        old.mat.dispose();
        old.textTexture.dispose();
        old.textMat.dispose();
        photoEntries[index] = null;
      }

      const imgW = work.photo?.width || 1;
      const imgH = work.photo?.height || 1;
      const aspect = imgW / imgH;

      let planeW: number;
      let planeH: number;
      
      // 最大サイズに合わせて調整
      if (aspect < 1) {
        // 縦長
        planeW = 1;
        planeH = planeW / aspect;
      } else {
        // 横長
        planeH = 1;
        planeW = planeH * aspect;
      }

      // 写真とフレームを半分のサイズにする
      planeW = planeW * 0.5;
      planeH = planeH * 0.5;

      const baseBottom = 1.5;
      const centerY = baseBottom + planeH / 2;
      // 配置ロジック: index 0,1 は壁1(奥)、index 2 は壁2(手前)
      // spacing を小さくして 2 枚並んでいる写真の間隔を狭める
      const spacing = 1.25; // 以前は 2.5
      const wallFrontZ = 0.89; // 3枚目（前面）のデフォルトを少し手前に調整
      const xOffset = index < 2 ? (index - 0.5) * spacing : 0.5;
      const zPos = index < 2 ? -0.89 : wallFrontZ;
      const rotY = index < 2 ? Math.PI : 0;

      // rotY は既に上で定義済み

      // 新規作成
      if (!photoEntries[index]) {
        const photoPlane = MeshBuilder.CreatePlane(`photo${index}`, { width: planeW, height: planeH }, scene);
        photoPlane.position = new Vector3(xOffset, centerY, zPos);
        photoPlane.rotation.y = rotY;

        const mat = new StandardMaterial(`photoMat${index}`, scene);
        mat.backFaceCulling = false;
        mat.disableLighting = true;
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.diffuseTexture = new Texture(work.photo.url, scene);
        try { registerTexture(mat.diffuseTexture as Texture, work.photo.url); } catch (e) { /* ignore */ }
        mat.emissiveTexture = mat.diffuseTexture;
        
        // コントラスト調整: 高すぎるコントラストを緩和
        mat.diffuseTexture!.level = 0.9; // 明るさを少し落とす
        mat.emissiveTexture!.level = 0.85; // エミッシブも同様に
        
        photoPlane.material = mat;

        // White frame
        // Increase thickness to make the frame more visible (previously 0.04)
        const frameThickness = 0.08;
        const whiteFramePlane = MeshBuilder.CreatePlane(`frame_white${index}`, { width: planeW + frameThickness * 2, height: planeH + frameThickness * 2 }, scene);
          const zDir = index < 2 ? -1 : 1; 
          const whitezPos = zPos + (0.004 * zDir); 
        whiteFramePlane.position = new Vector3(xOffset, centerY, whitezPos);
        whiteFramePlane.rotation.y = rotY;
        const whiteFrameMat = new StandardMaterial(`frameWhiteMat${index}`, scene);
        whiteFrameMat.disableLighting = true;
        whiteFrameMat.emissiveColor = new Color3(1, 1, 1);
        whiteFrameMat.freeze();
        whiteFramePlane.material = whiteFrameMat;

        // Black frame
        // Keep slightly thinner than the white frame for the inner border
        const blackFrameThickness = 0.04;
        const blackFramePlane = MeshBuilder.CreatePlane(`frame_black${index}`, { width: planeW + blackFrameThickness * 2, height: planeH + blackFrameThickness * 2 }, scene);
        const blackzPos = zPos + (0.002 * zDir);
        blackFramePlane.position = new Vector3(xOffset, centerY, blackzPos);
        blackFramePlane.rotation.y = rotY;
        const blackFrameMat = new StandardMaterial(`frameBlackMat${index}`, scene);
        blackFrameMat.disableLighting = true;
        blackFrameMat.emissiveColor = new Color3(0, 0, 0);
        blackFrameMat.freeze();
        blackFramePlane.material = blackFrameMat;

        // Text Plane
        const textW = 1.5;
        const textH = 0.6;
        const textPlane = MeshBuilder.CreatePlane(`text${index}`, { width: textW, height: textH }, scene);
        const gap = 0.02; // 画像に近づける
        const textY = centerY - planeH / 2 - gap - textH / 2; // 画像の下に配置
        // テキストを写真に少し近づける（ビューア側へ）
        const textOffset = 0.005;
        const textzPos = zPos - (textOffset * (index < 2 ? -1 : 1));
        textPlane.position = new Vector3(xOffset, textY, textzPos);
        textPlane.rotation.y = rotY;

        // DynamicTextureでテキストを作成 (2x for crisper text)
        // use global TEXT_SCALE
        const TEXT_BASE_WIDTH = 1024;
        const TEXT_BASE_HEIGHT = 410;
        const textTexture = new DynamicTexture(`textTexture${index}`, { width: TEXT_BASE_WIDTH * TEXT_SCALE, height: TEXT_BASE_HEIGHT * TEXT_SCALE }, scene);
        // prefer trilinear sampling for downscaling; adjust if pixel-art desired
        try { textTexture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE); } catch (e) { /* ignore */ }
        textTexture.hasAlpha = true;

        const textMat = new StandardMaterial(`textMat${index}`, scene);
        textMat.diffuseTexture = textTexture;
        textMat.emissiveTexture = textTexture;
        textMat.useAlphaFromDiffuseTexture = true;
        textMat.disableLighting = true;
        textMat.backFaceCulling = false;
        textPlane.material = textMat;
        
        // テキスト内容の準備
        const titleText = work.title || '';
        const rawBodyHtml = work.body || '';
        const temp = document.createElement('div');
        temp.innerHTML = rawBodyHtml;
        let fDate = '';
        if (work.shootingdate) {
          const d = new Date(work.shootingdate);
          fDate = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        }

        // 描画実行
        // drawTextOnTexture 側で <br> を改行に変換するので、元の HTML を渡す
        drawTextOnTexture(textTexture, titleText, rawBodyHtml, fDate);
        textMat.freeze();

        photoEntries[index] = {
          photoPlane,
          mat,
          whiteFramePlane,
          blackFramePlane,
          textPlane,
          textMat,
          textTexture,
          originalZ: zPos,
        };
      }
    };

    const hideEntry = (index: number) => {
      const entry = photoEntries[index];
      if (entry) {
        entry.photoPlane.setEnabled(false);
        entry.whiteFramePlane.setEnabled(false);
        entry.blackFramePlane.setEnabled(false);
        entry.textPlane.setEnabled(false);
      }
    }

    // --- データ取得 ---
    const loadPhotos = async (offset = 0) => {
      try {
        const apiKey = import.meta.env.VITE_MICROCMS_API_KEY;
        if (!apiKey) {
          console.error('API Key not found. Please set VITE_MICROCMS_API_KEY in .env.local');
          return;
        }

        // 開発環境: 直接API呼び出し
        // 本番環境(Netlify): Netlify Functions経由
        const isDev = import.meta.env.DEV;
        const url = isDev
          ? `https://liangworks.microcms.io/api/v1/taiwanphoto?limit=3&offset=${offset}`
          : `/.netlify/functions/microcms?limit=3&offset=${offset}`;
        
        console.log(`[loadPhotos] Fetching from ${isDev ? 'MicroCMS (dev)' : 'Netlify Functions (prod)'}: ${url}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒タイムアウト
        let _fetchDone: any = null;

        try {
          const fetchOptions: RequestInit = {
            signal: controller.signal,
          };
          
          // 開発環境のみAPIキーをヘッダーに付与
          if (isDev) {
            fetchOptions.headers = { 'X-MICROCMS-API-KEY': apiKey };
          }

          // Register this fetch as an asset for progress reporting
          try { _fetchDone = registerAsset(url); } catch (e) { /* ignore */ }

          const res = await fetch(url, fetchOptions);
          clearTimeout(timeoutId);
          
          console.log(`[loadPhotos] API response status: ${res.status}`);
          
          if (!res.ok) {
            const errorText = await res.text().catch(() => 'No response text');
            throw new Error(`API Error: ${res.status} ${res.statusText} - ${errorText}`);
          }
          
          if (scene.isDisposed) {
            if (_fetchDone) { try { _fetchDone(); } catch (e) { /* ignore */ } _fetchDone = null; }
            return;
          }
  
          const data: MicroCMSResponse = await res.json();
          totalCount = data.totalCount || 0;
          pageOffset = offset;
  
          const items = data.contents;
          for (let i = 0; i < 3; i++) {
            if (items[i]) {
              createOrUpdateEntry(items[i], i);
            } else {
              hideEntry(i);
            }
          }
          console.log(`[loadPhotos] Success: offset=${offset}, count=${items.length}, total=${totalCount}`);
          if (_fetchDone) { try { _fetchDone(); } catch (e) { /* ignore */ } _fetchDone = null; }
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (_fetchDone) { try { _fetchDone(); } catch (e) { /* ignore */ } _fetchDone = null; }
          if (fetchError instanceof Error) {
            if (fetchError.name === 'AbortError') {
              console.error('[loadPhotos] API request timeout (10s)');
            } else {
              console.error('[loadPhotos] API fetch error:', fetchError.message);
              console.error('[loadPhotos] Stack:', fetchError.stack);
            }
          } else {
            console.error('[loadPhotos] API fetch error:', fetchError);
          }
        }
      } catch (e) {
        console.error('[loadPhotos] Error:', e);
      }
    };
    
    // --- アニメーション ---
    const animateMeshZ = (mesh: Mesh, from: number, to: number, durationMs = 400) => {
      return new Promise<void>((resolve) => {
        if (scene.isDisposed) {
            resolve();
            return;
        }
        const fps = 60;
        const frameCount = Math.round((durationMs / 1000) * fps);
        const anim = new Animation('animZ', 'position.z', fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        
        const keys = [
          { frame: 0, value: from },
          { frame: frameCount, value: to },
        ];
        anim.setKeys(keys);
        
        const easing = new CubicEase();
        easing.setEasingMode(2);
        anim.setEasingFunction(easing);

        mesh.animations = [anim];
        scene.beginAnimation(mesh, 0, frameCount, false, 1, () => resolve());
      });
    };

    const pageSlide = async (direction: 1 | -1) => {
      // キューに追加して前の処理完了後に実行
      slideQueue = slideQueue.then(async () => {
        return new Promise<void>(async (resolve) => {
          try {
            // 1. animate out
            const outPromises: Promise<void>[] = [];
            photoEntries.forEach((e, i) => {
              if (!e || !e.photoPlane.isEnabled()) return;
              
              let targetZ: number;
              if (i < 2) {
                  targetZ = -1.5; // Wall 1
              } else {
                  targetZ = 1.5; // Wall 2
              }

              const delta = targetZ - e.originalZ;
              outPromises.push(animateMeshZ(e.photoPlane, e.photoPlane.position.z, targetZ));
              outPromises.push(animateMeshZ(e.whiteFramePlane, e.whiteFramePlane.position.z, e.whiteFramePlane.position.z + delta));
              outPromises.push(animateMeshZ(e.blackFramePlane, e.blackFramePlane.position.z, e.blackFramePlane.position.z + delta));
              outPromises.push(animateMeshZ(e.textPlane, e.textPlane.position.z, e.textPlane.position.z + delta));
            });

            await Promise.all(outPromises);

            // 2. データ更新
            let nextOffset = pageOffset + 3 * direction;
            if (nextOffset < 0) {
              const maxPageStart = Math.floor((totalCount - 1) / 3) * 3;
              nextOffset = maxPageStart;
            } else if (nextOffset >= totalCount) {
              nextOffset = 0;
            }
            
            await loadPhotos(nextOffset);

            // 3. animate in
            const inPromises: Promise<void>[] = [];
            photoEntries.forEach((e, i) => {
              if (!e || !e.photoPlane.isEnabled()) return;
              
              let hiddenZ: number;
              if (i < 2) {
                  hiddenZ = -1.5;
              } else {
                  hiddenZ = 1.5;
              }
              const zDir = i < 2 ? -1 : 1; 
              
              // アニメーション: hidden -> original
              inPromises.push(animateMeshZ(e.photoPlane, hiddenZ, e.originalZ));
              
              // フレームなどの相対位置
              const whiteTarget = e.originalZ + (0.002 * zDir);
              const whiteHidden = hiddenZ + (0.002 * zDir);
              inPromises.push(animateMeshZ(e.whiteFramePlane, whiteHidden, whiteTarget));
              
              const blackTarget = e.originalZ + (0.001 * zDir);
              const blackHidden = hiddenZ + (0.001 * zDir);
              inPromises.push(animateMeshZ(e.blackFramePlane, blackHidden, blackTarget));
              
              // テキスト: 隠れ位置/目標位置を写真と同じようにオフセットして扱う
              const textOffset = 0.01;
              const hiddenTextZ = hiddenZ - (textOffset * zDir);
              const targetTextZ = e.originalZ - (textOffset * zDir);
              inPromises.push(animateMeshZ(e.textPlane, hiddenTextZ, targetTextZ));
            });
            
            await Promise.all(inPromises);
            resolve();
          } catch (e) {
            console.error('pageSlide error', e);
            resolve();
          }
        });
      });
    };

    // 初期ロード
    loadPhotos();

    // イベント
    scene.onPointerObservable.add((pi) => {
      if (pi.type === PointerEventTypes.POINTERDOWN && pi.pickInfo?.hit && pi.pickInfo.pickedMesh) {
        const meshName = pi.pickInfo.pickedMesh.name;
        if (meshName === 'groundArrow1') {
          pageSlide(1);
        } else if (meshName === 'groundArrow2') {
          pageSlide(-1);
        }
      }
    });

    // VR
    const createXR = async () => {
      try {
        const xr = await scene.createDefaultXRExperienceAsync({
          floorMeshes: [ground],
          uiOptions: {
            sessionMode: 'immersive-vr',
          },
        });
        
        if (xr.baseExperience) {
          // 確実に壁の間の中央に配置する
          xr.baseExperience.camera.position = new Vector3(0, 1.6, 0);
          xrBaseExperience = xr.baseExperience;
          xrCamera = xrBaseExperience.camera;

          // セッション開始/終了で BGM を制御
          xr.baseExperience.sessionManager.onXRSessionInit.add(() => {
            console.log('XR Session Init');
            isInXR = true;

            // XRコントローラーのポインター選択機能を確認・設定
            // scene.onPointerObservableはXR環境でも動作するため、
            // 既存のfrontpage用ハンドラーで処理される
            console.log('[XR] VR mode enabled - scene.onPointerObservable should handle frontpage picks');

            // If there is a DOM audio element already playing, create a Babylon Sound from it (spatial)
            if (!bgmSound && bgmAudio) {
              try {
                console.log('[XR] Creating Babylon Sound from existing HTMLAudioElement for spatial audio');
                const domSound = new Sound('bgm', bgmAudio, scene, () => {
                  console.log('[XR] Babylon Sound created from HTMLAudioElement');
                }, { loop: true, spatialSound: true, autoplay: false, volume: bgmAudio?.volume ?? 0.5 });
                bgmSound = domSound;
                bgmSoundIsFromAudioElement = true;
                try {
                  const fp = scene.getMeshByName('frontpage');
                  if (fp && bgmSound) { bgmSound.attachToMesh(fp); console.log('[XR] attached bgmSound to frontpage'); }
                } catch (e) { console.warn('[XR] failed to attach created sound to mesh', e); }
                // if the DOM audio is currently playing, pause it and start the Babylon Sound so playback remains continuous through the spatializer
                try {
                  if (bgmAudio) {
                    wasBgmAudioPlayingBeforeXr = !bgmAudio.paused;
                    if (!bgmAudio.paused) {
                      bgmAudio.pause();
                      console.log('[XR] paused HTMLAudioElement to hand off playback to Babylon Sound');
                      try { bgmSound.play(); bgmPlaying = true; console.log('[XR] started Babylon Sound after handoff'); } catch (e) { console.warn('[XR] failed to start Babylon Sound after handoff', e); }
                    }
                  }
                } catch (e) { /* ignore */ }
              } catch (e) {
                console.warn('[XR] failed to create Babylon Sound from DOM audio', e);
              }
            }

            // XR camera を矢印の中間に配置して中央に揃える
            try {
              const arrow1 = scene.getMeshByName('groundArrow1') as Mesh | null;
              const arrow2 = scene.getMeshByName('groundArrow2') as Mesh | null;
              let centerX = 0;
              let centerZ = 0;
              if (arrow1 && arrow2) {
                try {
                  const p1 = arrow1.getAbsolutePosition();
                  const p2 = arrow2.getAbsolutePosition();
                  centerX = (p1.x + p2.x) / 2;
                  centerZ = (p1.z + p2.z) / 2;
                } catch (e) { /* ignore */ }
              }

              if (xrCamera) {
                // Adjust the camera rig parent so the user's origin aligns with the arrow midpoint.
                const rigParent = (xrCamera as any).rigParent || (xrBaseExperience && xrBaseExperience.camera && (xrBaseExperience.camera as any).rigParent);
                if (rigParent) {
                  try { rigParent.position = new Vector3(-centerX, 0, -centerZ); xrRecentered = true; } catch (e) { /* ignore */ }
                } else {
                  // fallback: set camera position (may not stick in XR)
                  try { xrCamera.position = new Vector3(centerX, 1.6, centerZ); } catch (e) { /* ignore */ }
                }
                // optionally orient camera forward
                try {
                  if (typeof xrCamera.setTarget === 'function') {
                    xrCamera.setTarget(new Vector3(centerX, 1.6, centerZ + 1));
                  }
                } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore */ }
            // Ensure the audio context resumes (handled by browser/Babylon), then play
            if (bgmSound && !bgmPlaying) {
              void toggleBgm();
            }
          });

          // apply recenter if arrows were created before XR start
          maybeCenterXR();

          xr.baseExperience.sessionManager.onXRSessionEnded.add(async () => {
            console.log('XR Session Ended');
            try {
              if (bgmSound && bgmPlaying) {
                try {
                  bgmSound.pause();
                  console.log('[XR] paused bgmSound');
                } catch (e) { console.warn('[XR] error pausing bgmSound', e); }
                bgmPlaying = false;
              }

              if (bgmSoundIsFromAudioElement) {
                // If we created the Babylon Sound from DOM audio in XR, destroy it and restore DOM audio playback if it was playing before XR
                try {
                  bgmSound?.dispose();
                } catch (_) { /* ignore */ }
                bgmSound = null;
                bgmSoundIsFromAudioElement = false;
                if (bgmAudio && wasBgmAudioPlayingBeforeXr) {
                  try { await bgmAudio.play(); bgmPlaying = true; console.log('[XR] resumed HTMLAudioElement after exiting XR'); } catch (e) { console.warn('[XR] failed to resume HTMLAudioElement after XR', e); }
                }
                wasBgmAudioPlayingBeforeXr = false;
              }
            } catch (e) { console.warn('XR exit BGM cleanup failed', e); }
            isInXR = false;
          });
        }
      } catch (error) {
        console.error('WebXR error:', error);
      }
    };
    createXR();

    // ループ
    engine.runRenderLoop(() => {
      // Listener and source position updating is handled by Babylon's Sound system
      scene.render();
    });

    // リサイズ
    const handleResize = () => {
      engine.resize();
    };
    window.addEventListener('resize', handleResize);

    // クリーンアップ
    return () => {
      window.removeEventListener('resize', handleResize);
      if (bgmSound) {
        try { bgmSound.pause(); } catch (e) { /* ignore */ }
        try { bgmSound.stop(); } catch (e) { /* ignore */ }
        try { bgmSound.dispose(); } catch (e) { /* ignore */ }
        bgmSound = null;
      }
      if (loadingOverlay && loadingOverlay.parentElement) {
        try { loadingOverlay.parentElement.removeChild(loadingOverlay); } catch (e) { /* ignore */ }
      }
      // Using Babylon Sound for spatial audio (AudioEngineV2)
      scene.dispose();
      engine.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: '100vh',
        display: 'block',
        outline: 'none',
      }}
    />
  );
}

export default App;