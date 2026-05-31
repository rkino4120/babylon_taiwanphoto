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
import { CreateAudioEngineAsync, CreateSoundAsync } from '@babylonjs/core/AudioV2';
import type { AudioEngineV2, StaticSound } from '@babylonjs/core/AudioV2';

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

    // AudioEngineV2の初期化
    let audioEngine: AudioEngineV2 | null = null;
    const initAudioEngine = async () => {
      if (audioEngine) return audioEngine;
      try {
        audioEngine = await CreateAudioEngineAsync();
        if (scene.isDisposed) return null;
        console.log('AudioEngineV2 initialized');
        // リスナーをカメラにアタッチ（空間音に必要）
        audioEngine.listener.attach(camera);
        console.log('Audio listener attached to camera');
        return audioEngine;
      } catch (e) {
        console.warn('Failed to initialize AudioEngineV2', e);
        return null;
      }
    };

    // カメラ
    const camera = new ArcRotateCamera(
      'camera',
      -Math.PI / 2,
      Math.PI / 2.5,
      2,
      new Vector3(-2, 1.6, 0),
      scene
    );
    // 90度（π/2）回転
    camera.alpha += Math.PI / 2;
    camera.attachControl(canvasRef.current, true);
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
      spotLight.intensity = 1.2;
      spotLight.innerAngle = Math.PI / 6;
    });

    // --- 変数管理 ---
    const photoEntries: Array<PhotoEntry | null> = [null, null, null];
    let pageOffset = 0;
    let totalCount = 0;
    // ページスライドの非同期処理キュー（競合回避）
    let slideQueue: Promise<void> = Promise.resolve();
    // スライド実行中のロックフラグ（連打ガード）
    let isSliding = false;
    // BGM 用サウンドハンドル
    let bgm: StaticSound | null = null;
    let bgmPlaying = false;

    // XR state
    let xrExperience: any = null;
    let isInXR = false;

    // XR movement bounds (world coords)
    const XR_BOUNDS = { minX: -4.5, maxX: 4.5, minZ: -0.85, maxZ: 0.85 };
    const clampXRPosition = (pos: Vector3) => {
      if (!pos) return pos;
      const x = Math.max(XR_BOUNDS.minX, Math.min(XR_BOUNDS.maxX, pos.x));
      const y = pos.y;
      const z = Math.max(XR_BOUNDS.minZ, Math.min(XR_BOUNDS.maxZ, pos.z));
      return new Vector3(x, y, z);
    };

    // BGM 再生/一時停止トグル
    const toggleBgm = async () => {
      if (!bgm) {
        console.log('toggleBgm: BGM not ready');
        return;
      }

      if (bgmPlaying) {
        try {
          bgm.pause();
          bgmPlaying = false;
          console.log('BGM paused');
        } catch (e) { 
          console.warn('toggleBgm: pause failed', e); 
        }
      } else {
        try {
          bgm.play();
          bgmPlaying = true;
          console.log('BGM playing');
        } catch (e) { 
          console.warn('toggleBgm: play failed', e); 
        }
      }
    };

    // --- 床・壁の作成 ---
    const ground = MeshBuilder.CreateGround('ground', { width: 10, height: 10 }, scene);
    const groundMaterial = new StandardMaterial('groundMaterial', scene);
    const diffuseTexture = new Texture('images/concrete_floor_worn_001_diff_1k.jpg', scene);
    diffuseTexture.uScale = 5;
    diffuseTexture.vScale = 5;
    groundMaterial.diffuseTexture = diffuseTexture;
    const bumpTexture = new Texture('images/concrete_floor_worn_001_nor_gl_1k.png', scene);
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
    const arrowTex = new Texture('images/arrow.png', scene);
    arrowTex.hasAlpha = true;
    const arrowMat = new StandardMaterial('arrowMat', scene);
    arrowMat.diffuseTexture = arrowTex;
    arrowMat.emissiveTexture = arrowTex;
    arrowMat.useAlphaFromDiffuseTexture = true;
    arrowMat.disableLighting = true;
    arrowMat.backFaceCulling = false;
    arrowMat.freeze();

    const arrowImg = new Image();
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
    };
    arrowImg.src = 'images/arrow.png';

    // 壁マテリアル
    const wallMaterial = new StandardMaterial('wallMaterial', scene);
    wallMaterial.backFaceCulling = false;
    const wallDiffuseTexture = new Texture('images/painted_plaster_wall_diff_1k.jpg', scene);
    wallDiffuseTexture.uScale = 5;
    wallDiffuseTexture.vScale = 2;
    wallMaterial.diffuseTexture = wallDiffuseTexture;
    const wallBumpTexture = new Texture('images/painted_plaster_wall_nor_gl_1k.png', scene);
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

    // frontpage / profilepage を wall2 の前面に配置
    const frontMat = new StandardMaterial('frontpageMat', scene);
    frontMat.disableLighting = true;
    frontMat.backFaceCulling = false;

    const profileMat = new StandardMaterial('profilepageMat', scene);
    profileMat.disableLighting = true;
    profileMat.backFaceCulling = false;

    // frontpage: 画像を読み込んでアスペクト比に基づきリサイズ（高さ基準）
    const frontImg = new Image();
    let frontLoaded = false;
    frontImg.onload = async () => {
      if (frontLoaded || scene.isDisposed) return;
      frontLoaded = true;
      const iw = frontImg.naturalWidth || 1;
      const ih = frontImg.naturalHeight || 1;
      const aspect = iw / ih;
      const targetH = 0.4; // 基準高さ
      const targetW = targetH * aspect;

      frontMat.diffuseTexture = new Texture('images/frontpage.jpg', scene);
      frontMat.emissiveTexture = frontMat.diffuseTexture;

      const frontPlane = MeshBuilder.CreatePlane('frontpage', { width: targetW, height: targetH }, scene);
      frontPlane.position = new Vector3(-1.2, 1.5, 0.89);
      frontPlane.rotation.y = 0;
      frontPlane.material = frontMat;
      frontPlane.isPickable = true;
      frontPlane.doNotSyncBoundingInfo = true;
      frontPlane.freezeWorldMatrix();
      frontMat.freeze();

      // ポインタ選択時に BGM トグル
      scene.onPointerObservable.add((pi) => {
        if (pi.type !== PointerEventTypes.POINTERUP) return;
        const pickInfo = pi.pickInfo;
        if (pickInfo && pickInfo.hit && pickInfo.pickedMesh === frontPlane) {
          toggleBgm();
        }
      });

      // BGM をロード
      try {
        const audioEng = await initAudioEngine();
        if (audioEng && !scene.isDisposed) {
          bgm = await CreateSoundAsync('bgm', 'sound/bgm.mp3', {
            loop: true,
            volume: 0.5,
            autoplay: false,
            spatialEnabled: true,
            spatialDistanceModel: 'inverse',
            spatialMinDistance: 1,
            spatialMaxDistance: 20,
            spatialRolloffFactor: 1,
            spatialPanningModel: 'HRTF',
          });
          if (!scene.isDisposed && bgm) {
            console.log('BGM loaded successfully');
            bgm.spatial.attach(frontPlane);
            console.log('BGM spatial audio attached to frontPlane');
          }
        }
      } catch (e) {
        console.warn('BGM load failed', e);
        bgm = null;
      }
    };
    frontImg.src = 'images/frontpage.jpg';

    // profilepage
    const profileImg = new Image();
    let profileLoaded = false;
    profileImg.onload = () => {
      if (profileLoaded || scene.isDisposed) return;
      profileLoaded = true;
      const iw = profileImg.naturalWidth || 1;
      const ih = profileImg.naturalHeight || 1;
      const aspect = iw / ih;
      const targetH = 0.4;
      const targetW = targetH * aspect;

      profileMat.diffuseTexture = new Texture('images/profilepage.jpg', scene);
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
    profileImg.src = 'images/profilepage.jpg';

    // --- ヘルパー: テキスト描画 ---
    const drawTextOnTexture = (texture: DynamicTexture, title: string, body: string, date: string) => {
      const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
      const width = 1024;
      const height = 410;

      // クリア
      ctx.clearRect(0, 0, width, height);

      // タイトル
      ctx.font = "bold 24px 'Noto Sans JP', sans-serif";
      ctx.fillStyle = "white";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, width / 2, 80);

      // 本文（簡易折り返し + <br> 対応）
      ctx.font = "10px 'Noto Sans JP', sans-serif";
      ctx.fillStyle = "white";
      const maxLineWidth = 900;
      const lineHeight = 30;
      let y = 150;

      const tempDiv = document.createElement('div');
      const withBreaks = (body || '').replace(/<br\s*\/?>/gi, '\n');
      tempDiv.innerHTML = withBreaks;
      const bodyText = tempDiv.textContent || tempDiv.innerText || '';

      const paragraphs = bodyText.split(/\r?\n/);
      paragraphLoop: for (let p = 0; p < paragraphs.length; p++) {
        const para = paragraphs[p] || '';
        const chars = para.split('');
        let line = '';

        for (let n = 0; n < chars.length; n++) {
          const testLine = line + chars[n];
          const testWidth = ctx.measureText(testLine).width;
          if (testWidth > maxLineWidth && n > 0) {
            ctx.fillText(line, width / 2, y);
            line = chars[n];
            y += lineHeight;
            if (y > 320) break paragraphLoop;
          } else {
            line = testLine;
          }
        }

        if (y <= 320) {
          ctx.fillText(line, width / 2, y);
        }

        y += lineHeight;
        if (y > 320) break;
      }

      // 日付
      ctx.font = "10px 'Noto Sans JP', sans-serif";
      ctx.fillStyle = "#cccccc";
      ctx.fillText(date, width / 2, 220);

      texture.update();
    };

    // --- 写真作成・更新ロジック (オブジェクトプーリング適用) ---
    const createOrUpdateEntry = (work: WorkItem, index: number) => {
      if (scene.isDisposed) return;

      const imgW = work.photo?.width || 1;
      const imgH = work.photo?.height || 1;
      const aspect = imgW / imgH;

      let planeW: number;
      let planeH: number;
      
      if (aspect < 1) {
        planeW = 0.5;
        planeH = 0.5 / aspect;
      } else {
        planeH = 0.5;
        planeW = 0.5 * aspect;
      }

      const baseBottom = 1.5;
      const centerY = baseBottom + planeH / 2;
      const spacing = 1.25;
      const wallFrontZ = 0.89;
      const xOffset = index < 2 ? (index - 0.5) * spacing : 0.5;
      const zPos = index < 2 ? -0.89 : wallFrontZ;
      const rotY = index < 2 ? Math.PI : 0;
      const zDir = index < 2 ? -1 : 1;

      let entry = photoEntries[index];

      // 初回のみ3Dメッシュ構造体を生成（それ以外は既存リソースを使い回す）
      if (!entry) {
        // メッシュはスケーリングをかけるためデフォルトサイズ 1x1 で生成
        const photoPlane = MeshBuilder.CreatePlane(`photo${index}`, { width: 1, height: 1 }, scene);
        photoPlane.rotation.y = rotY;

        const mat = new StandardMaterial(`photoMat${index}`, scene);
        mat.backFaceCulling = false;
        mat.disableLighting = true;
        photoPlane.material = mat;

        const whiteFramePlane = MeshBuilder.CreatePlane(`frame_white${index}`, { width: 1, height: 1 }, scene);
        whiteFramePlane.rotation.y = rotY;
        const whiteFrameMat = new StandardMaterial(`frameWhiteMat${index}`, scene);
        whiteFrameMat.disableLighting = true;
        whiteFrameMat.emissiveColor = new Color3(1, 1, 1);
        whiteFrameMat.freeze();
        whiteFramePlane.material = whiteFrameMat;

        const blackFramePlane = MeshBuilder.CreatePlane(`frame_black${index}`, { width: 1, height: 1 }, scene);
        blackFramePlane.rotation.y = rotY;
        const blackFrameMat = new StandardMaterial(`frameBlackMat${index}`, scene);
        blackFrameMat.disableLighting = true;
        blackFrameMat.emissiveColor = new Color3(0, 0, 0);
        blackFrameMat.freeze();
        blackFramePlane.material = blackFrameMat;

        const textPlane = MeshBuilder.CreatePlane(`text${index}`, { width: 1.5, height: 0.6 }, scene);
        textPlane.rotation.y = rotY;

        const textTexture = new DynamicTexture(`textTexture${index}`, { width: 1024, height: 410 }, scene);
        textTexture.hasAlpha = true;

        const textMat = new StandardMaterial(`textMat${index}`, scene);
        textMat.diffuseTexture = textTexture;
        textMat.emissiveTexture = textTexture;
        textMat.useAlphaFromDiffuseTexture = true;
        textMat.disableLighting = true;
        textMat.backFaceCulling = false;
        textPlane.material = textMat;

        entry = {
          photoPlane,
          mat,
          whiteFramePlane,
          blackFramePlane,
          textPlane,
          textMat,
          textTexture,
          originalZ: zPos,
        };
        photoEntries[index] = entry;
      }

      // 非表示化されていた場合に有効に戻す
      entry.photoPlane.setEnabled(true);
      entry.whiteFramePlane.setEnabled(true);
      entry.blackFramePlane.setEnabled(true);
      entry.textPlane.setEnabled(true);

      // アスペクト比に基づくスケーリング調整 (CPU/GPU負荷が低い方法)
      const frameThickness = 0.04;
      const blackFrameThickness = 0.02;

      entry.photoPlane.scaling.set(planeW, planeH, 1);
      entry.whiteFramePlane.scaling.set(planeW + frameThickness * 2, planeH + frameThickness * 2, 1);
      entry.blackFramePlane.scaling.set(planeW + blackFrameThickness * 2, planeH + blackFrameThickness * 2, 1);

      // 位置を適用
      entry.photoPlane.position.set(xOffset, centerY, zPos);
      entry.whiteFramePlane.position.set(xOffset, centerY, zPos + (0.002 * zDir));
      entry.blackFramePlane.position.set(xOffset, centerY, zPos + (0.001 * zDir));

      const textH = 0.6;
      const gap = 0.02;
      const textY = centerY - planeH / 2 - gap - textH / 2;
      const textOffset = 0.005;
      const textzPos = zPos - (textOffset * zDir);
      entry.textPlane.position.set(xOffset, textY, textzPos);

      // 既存の古い写真テクスチャを処分してメモリリークを防ぎ、新規割り当て
      if (entry.mat.diffuseTexture) {
        entry.mat.diffuseTexture.dispose();
      }
      const photoTexture = new Texture(work.photo.url, scene);
      photoTexture.level = 0.9;
      entry.mat.diffuseTexture = photoTexture;
      entry.mat.emissiveTexture = photoTexture;

      // 日付フォーマット
      let fDate = '';
      if (work.shootingdate) {
        const d = new Date(work.shootingdate);
        fDate = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      }

      // テキスト内容を書き換える
      entry.textMat.unfreeze();
      drawTextOnTexture(entry.textTexture, work.title || '', work.body || '', fDate);
      entry.textMat.freeze();
    };

    const hideEntry = (index: number) => {
      const entry = photoEntries[index];
      if (entry) {
        entry.photoPlane.setEnabled(false);
        entry.whiteFramePlane.setEnabled(false);
        entry.blackFramePlane.setEnabled(false);
        entry.textPlane.setEnabled(false);
      }
    };

    // --- データ取得 ---
    const loadPhotos = async (offset = 0) => {
      try {
        const apiKey = import.meta.env.VITE_MICROCMS_API_KEY;
        const isDev = import.meta.env.DEV;

        // 本番ではNetlify Functions経由。開発時のみ、かつAPIキーが存在する場合に直叩きを許容
        if (isDev && !apiKey) {
          console.error('API Key not found. Please set VITE_MICROCMS_API_KEY in .env.local');
          return;
        }

        const url = isDev
          ? `https://liangworks.microcms.io/api/v1/taiwanphoto?limit=3&offset=${offset}`
          : `/.netlify/functions/microcms?limit=3&offset=${offset}`;
        
        console.log(`[loadPhotos] Fetching: ${url}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒タイムアウト

        try {
          const fetchOptions: RequestInit = {
            signal: controller.signal,
          };
          
          if (isDev && apiKey) {
            fetchOptions.headers = { 'X-MICROCMS-API-KEY': apiKey };
          }
          
          const res = await fetch(url, fetchOptions);
          clearTimeout(timeoutId);
          
          if (!res.ok) {
            const errorText = await res.text().catch(() => 'No response text');
            throw new Error(`API Error: ${res.status} - ${errorText}`);
          }
          
          if (scene.isDisposed) return;
  
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
        } catch (fetchError) {
          clearTimeout(timeoutId);
          console.error('[loadPhotos] Fetch execution error:', fetchError);
        }
      } catch (e) {
        console.error('[loadPhotos] Core error:', e);
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
      // ロック中、もしくは破棄済みはガード
      if (isSliding || scene.isDisposed) return;
      isSliding = true;

      // キューに追加して前の処理完了後に実行
      slideQueue = slideQueue.then(async () => {
        return new Promise<void>(async (resolve) => {
          try {
            if (scene.isDisposed) {
              resolve();
              return;
            }

            // 1. animate out
            const outPromises: Promise<void>[] = [];
            photoEntries.forEach((e, i) => {
              if (!e || !e.photoPlane.isEnabled()) return;
              
              const targetZ = i < 2 ? -1.5 : 1.5;
              const delta = targetZ - e.originalZ;
              
              outPromises.push(animateMeshZ(e.photoPlane, e.photoPlane.position.z, targetZ));
              outPromises.push(animateMeshZ(e.whiteFramePlane, e.whiteFramePlane.position.z, e.whiteFramePlane.position.z + delta));
              outPromises.push(animateMeshZ(e.blackFramePlane, e.blackFramePlane.position.z, e.blackFramePlane.position.z + delta));
              outPromises.push(animateMeshZ(e.textPlane, e.textPlane.position.z, e.textPlane.position.z + delta));
            });

            await Promise.all(outPromises);
            if (scene.isDisposed) {
              resolve();
              return;
            }

            // 2. データ更新
            let nextOffset = pageOffset + 3 * direction;
            if (nextOffset < 0) {
              const maxPageStart = Math.floor((totalCount - 1) / 3) * 3;
              nextOffset = maxPageStart;
            } else if (nextOffset >= totalCount) {
              nextOffset = 0;
            }
            
            await loadPhotos(nextOffset);
            if (scene.isDisposed) {
              resolve();
              return;
            }

            // 3. animate in
            const inPromises: Promise<void>[] = [];
            photoEntries.forEach((e, i) => {
              if (!e || !e.photoPlane.isEnabled()) return;
              
              const hiddenZ = i < 2 ? -1.5 : 1.5;
              const zDir = i < 2 ? -1 : 1; 
              
              inPromises.push(animateMeshZ(e.photoPlane, hiddenZ, e.originalZ));
              
              const whiteTarget = e.originalZ + (0.002 * zDir);
              const whiteHidden = hiddenZ + (0.002 * zDir);
              inPromises.push(animateMeshZ(e.whiteFramePlane, whiteHidden, whiteTarget));
              
              const blackTarget = e.originalZ + (0.001 * zDir);
              const blackHidden = hiddenZ + (0.001 * zDir);
              inPromises.push(animateMeshZ(e.blackFramePlane, blackHidden, blackTarget));
              
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

      // スライド完了後にロック解除
      await slideQueue;
      isSliding = false;
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
        
        // 非同期完了時にコンポーネントが破棄されていたら安全にリターン
        if (scene.isDisposed) return;
        xrExperience = xr;
        
        if (xr.baseExperience) {
          xr.baseExperience.camera.position = new Vector3(0, 1.6, 0);

          xr.baseExperience.sessionManager.onXRSessionInit.add(() => {
            console.log('XR Session Init: Starting BGM');
            isInXR = true;
            if (bgm && !bgmPlaying) {
              try {
                bgm.play();
                bgmPlaying = true;
                console.log('BGM started in XR Session');
              } catch (e) {
                console.warn('BGM play failed in XR Session', e);
              }
            }
          });

          xr.baseExperience.sessionManager.onXRSessionEnded.add(() => {
            console.log('XR Session Ended: Stopping BGM');
            isInXR = false;
            if (bgm) {
              try {
                bgm.stop();
                bgmPlaying = false;
              } catch (e) {
                console.warn('BGM stop failed', e);
              }
            }
          });
        }
      } catch (error) {
        console.error('WebXR error:', error);
      }
    };
    createXR();

    // Clamp XR movement each frame
    scene.onBeforeRenderObservable.add(() => {
      try {
        if (!isInXR || !xrExperience || !xrExperience.baseExperience) return;
        const cam = xrExperience.baseExperience.camera;
        if (!cam) return;
        const rigParent = (cam as any).rigParent || cam;
        if (!rigParent) return;
        const pos = rigParent.position;
        const clamped = clampXRPosition(pos);
        if (clamped.x !== pos.x || clamped.z !== pos.z) {
          try { rigParent.position.x = clamped.x; rigParent.position.z = clamped.z; } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    });

    // ループ
    engine.runRenderLoop(() => {
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
      if (bgm) {
        try { bgm.stop(); } catch (e) { /* ignore */ }
        try { bgm.dispose(); } catch (e) { /* ignore */ }
      }
      if (audioEngine) {
        try { audioEngine.dispose(); } catch (e) { /* ignore */ }
      }
      
      // プーリングで使用した残りのリソース解放
      photoEntries.forEach(entry => {
        if (entry) {
          if (entry.mat.diffuseTexture) entry.mat.diffuseTexture.dispose();
          entry.textTexture.dispose();
          entry.textMat.dispose();
        }
      });

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