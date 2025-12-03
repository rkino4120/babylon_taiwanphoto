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
    let photoEntries: Array<PhotoEntry | null> = [null, null, null];
    let pageOffset = 0;
    let totalCount = 0;
    // ページスライドの非同期処理キュー（競合回避）
    let slideQueue: Promise<void> = Promise.resolve();
    // BGM 用サウンドハンドル
    let bgm: StaticSound | null = null;
    let bgmPlaying = false;

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
        // frontPlane をクリック可能にして BGM トグルを割り当てる
        frontPlane.isPickable = true;
        frontPlane.doNotSyncBoundingInfo = true;
        frontPlane.freezeWorldMatrix();
        frontMat.freeze();

        // ポインタ（クリック / コントローラ選択）を監視して frontPlane をクリックしたらトグル
        scene.onPointerObservable.add((pi) => {
          if (pi.type !== PointerEventTypes.POINTERUP) return;
          const pickInfo = pi.pickInfo;
          if (pickInfo && pickInfo.hit && pickInfo.pickedMesh === frontPlane) {
            toggleBgm();
          }
        });

        // BGM をロード（CreateSoundAsync使用、空間化有効）
        try {
          const engine = await initAudioEngine();
          if (engine) {
            bgm = await CreateSoundAsync('bgm', 'sound/bgm.mp3', {
              loop: true,
              volume: 0.5,
              autoplay: false,
              // 空間化オプション
              spatialEnabled: true,
              spatialDistanceModel: 'inverse',
              spatialMinDistance: 1,
              spatialMaxDistance: 20,
              spatialRolloffFactor: 1,
              spatialPanningModel: 'HRTF', // 高品質な3Dオーディオ
            });
            console.log('BGM loaded successfully');
            // BGMの位置をfrontPlaneにアタッチ
            bgm.spatial.attach(frontPlane);
            console.log('BGM spatial audio attached to frontPlane');
          }
        } catch (e) {
          console.warn('BGM load failed', e);
          bgm = null;
        }
      };
      frontImg.src = 'images/frontpage.jpg';

      // profilepage: 同上（下側）
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
      // 型エラー回避のため、標準の CanvasRenderingContext2D にキャストします
      const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
      const width = 1024;
      const height = 410; // テクスチャサイズ

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
            ctx.fillText(line, width / 2, y);
            line = chars[n];
            y += lineHeight;
            if (y > 320) break paragraphLoop; // テクスチャ高さを超えたら終了
          } else {
            line = testLine;
          }
        }

        // 残りの行を描画
        if (y <= 320) {
          ctx.fillText(line, width / 2, y);
        }

        // 段落間の余白
        y += lineHeight;
        if (y > 320) break;
      }

      // 日付（少し上に表示）
      ctx.font = "10px 'Noto Sans JP', sans-serif";
      ctx.fillStyle = "#cccccc";
      ctx.fillText(date, width / 2, 220);

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
        mat.emissiveTexture = mat.diffuseTexture;
        
        // コントラスト調整: 高すぎるコントラストを緩和
        mat.diffuseTexture!.level = 0.9; // 明るさを少し落とす
        mat.emissiveTexture!.level = 0.85; // エミッシブも同様に
        
        photoPlane.material = mat;

        // White frame
        const frameThickness = 0.04; // 以前の 0.08 の半分
        const whiteFramePlane = MeshBuilder.CreatePlane(`frame_white${index}`, { width: planeW + frameThickness * 2, height: planeH + frameThickness * 2 }, scene);
          const zDir = index < 2 ? -1 : 1; 
          const whitezPos = zPos + (0.002 * zDir); 
        whiteFramePlane.position = new Vector3(xOffset, centerY, whitezPos);
        whiteFramePlane.rotation.y = rotY;
        const whiteFrameMat = new StandardMaterial(`frameWhiteMat${index}`, scene);
        whiteFrameMat.disableLighting = true;
        whiteFrameMat.emissiveColor = new Color3(1, 1, 1);
        whiteFrameMat.freeze();
        whiteFramePlane.material = whiteFrameMat;

        // Black frame
        const blackFrameThickness = 0.02; // 以前の 0.04 の半分
        const blackFramePlane = MeshBuilder.CreatePlane(`frame_black${index}`, { width: planeW + blackFrameThickness * 2, height: planeH + blackFrameThickness * 2 }, scene);
        const blackzPos = zPos + (0.001 * zDir);
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

        // DynamicTextureでテキストを作成 (1024x410)
        const textTexture = new DynamicTexture(`textTexture${index}`, { width: 1024, height: 410 }, scene);
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
            console.error("API Key is missing in environment variables");
            console.warn("Set VITE_MICROCMS_API_KEY in .env file or Netlify environment variables");
            return;
        }

        // Netlify プロキシ経由でも直接でも動作するよう条件分岐
        const isNetlify = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
        const url = isNetlify
          ? `https://${window.location.host}/api/microcms/v1/taiwanphoto?limit=3&offset=${offset}`
          : `https://liangworks.microcms.io/api/v1/taiwanphoto?limit=3&offset=${offset}`;
        
        console.log(`Loading photos from: ${url} (isNetlify: ${isNetlify})`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒タイムアウト

        try {
          const res = await fetch(url, {
            headers: { 'X-MICROCMS-API-KEY': apiKey },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          
          console.log(`API response status: ${res.status}`);
          
          if (!res.ok) {
            const errorText = await res.text().catch(() => 'No response text');
            throw new Error(`API Error: ${res.status} ${res.statusText} - ${errorText}`);
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
          console.log(`Photos loaded successfully: offset=${offset}, count=${items.length}, total=${totalCount}`);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError instanceof Error) {
            if (fetchError.name === 'AbortError') {
              console.error('API request timeout (10s) - Check network connectivity');
            } else {
              console.error('API fetch error:', fetchError.message);
              console.error('Stack:', fetchError.stack);
            }
          } else {
            console.error('API fetch error:', fetchError);
          }
          // フォールバック: プロキシでダメなら直接試行
          if (isNetlify && !url.includes('liangworks.microcms.io')) {
            console.log('Retrying with direct API endpoint...');
            return loadPhotos(offset);
          }
        }
      } catch (e) {
        console.error('loadPhotos error', e);
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

          // セッション開始/終了で BGM を制御
          xr.baseExperience.sessionManager.onXRSessionInit.add(() => {
            console.log('XR Session Init: Starting BGM');
            console.log('Audio listener position:', audioEngine?.listener.position);
            console.log('Audio listener attached:', audioEngine?.listener.isAttached);
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