import * as THREE from 'three';

export class PlayerOutline {
  constructor(renderer, ctColor, tColor) {
    this.renderer = renderer;
    this.maskScene = new THREE.Scene();
    this.maskScene.matrixWorldAutoUpdate = false;
    this.mask = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.ctMask = new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false });
    this.tMask = new THREE.MeshBasicMaterial({ color: 0x00ff00, toneMapped: false });
    this.players = [];
    this.clearColor = new THREE.Color();
    this.drawingSize = new THREE.Vector2();
    this.edge = new THREE.ShaderMaterial({
      uniforms: {
        playerMask: { value: this.mask.texture },
        playerDepth: { value: this.mask.depthTexture },
        stepUv: { value: new THREE.Vector2() },
        ctColor: { value: new THREE.Color(ctColor) },
        tColor: { value: new THREE.Color(tColor) },
      },
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D playerMask;
        uniform sampler2D playerDepth;
        uniform vec2 stepUv;
        uniform vec3 ctColor;
        uniform vec3 tColor;
        varying vec2 vUv;

        void findEdge(vec2 uv, inout float depth, inout vec3 color) {
          vec2 team = texture2D(playerMask, uv).rg;
          if (team.r + team.g < 0.5) return;
          float z = texture2D(playerDepth, uv).r;
          if (z >= depth) return;
          depth = z;
          color = team.r > team.g ? ctColor : tColor;
        }

        void main() {
          vec2 center = texture2D(playerMask, vUv).rg;
          if (center.r + center.g > 0.5) discard;
          float depth = 1.0;
          vec3 color = vec3(0.0);
          findEdge(vUv + vec2(stepUv.x, 0.0), depth, color);
          findEdge(vUv - vec2(stepUv.x, 0.0), depth, color);
          findEdge(vUv + vec2(0.0, stepUv.y), depth, color);
          findEdge(vUv - vec2(0.0, stepUv.y), depth, color);
          if (depth == 1.0) discard;
          gl_FragDepth = depth - 0.0000005;
          gl_FragColor = vec4(color, 0.9);
          #include <colorspace_fragment>
        }
      `,
    });
    this.edgeScene = new THREE.Scene();
    this.edgeCamera = new THREE.Camera();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.edge);
    this.quad.frustumCulled = false;
    this.edgeScene.add(this.quad);
  }

  add(root, body, team, defuseKit) {
    const material = team === 3 ? this.ctMask : this.tMask;
    const parts = [];
    body.traverse((source) => {
      if (!source.isMesh || (!source.visible && source !== defuseKit)) return;
      if (!Array.isArray(source.material) && source.material.transparent) return;
      const proxy = source.isSkinnedMesh
        ? new THREE.SkinnedMesh(source.geometry, material)
        : new THREE.Mesh(source.geometry, material);
      if (source.isSkinnedMesh) {
        proxy.skeleton = source.skeleton;
        proxy.bindMatrix.copy(source.bindMatrix);
      }
      proxy.frustumCulled = source.frustumCulled;
      this.maskScene.add(proxy);
      parts.push({ source, proxy });
    });
    this.players.push({ root, parts });
  }

  clear() {
    this.maskScene.clear();
    this.players.length = 0;
  }

  render(camera) {
    let hasPlayers = false;
    for (const { root, parts } of this.players) {
      const outlined = root.visible && root.userData.outlined;
      hasPlayers ||= outlined;
      for (const { source, proxy } of parts) {
        proxy.visible = outlined && source.visible;
        if (!proxy.visible) continue;
        proxy.matrixWorld.copy(source.matrixWorld);
        if (proxy.isSkinnedMesh) proxy.bindMatrixInverse.copy(source.bindMatrixInverse);
      }
    }
    if (!hasPlayers) return;

    const { renderer, mask, drawingSize } = this;
    renderer.getDrawingBufferSize(drawingSize);
    if (mask.width !== drawingSize.x || mask.height !== drawingSize.y) {
      mask.setSize(drawingSize.x, drawingSize.y);
    }
    const canvas = renderer.domElement;
    this.edge.uniforms.stepUv.value.set(1.85 / canvas.clientWidth, 1.85 / canvas.clientHeight);
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(mask);
    renderer.setClearColor(0, 0);
    renderer.clear();
    renderer.render(this.maskScene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(this.clearColor, clearAlpha);
    renderer.render(this.edgeScene, this.edgeCamera);
  }

  dispose() {
    this.clear();
    this.mask.dispose();
    this.ctMask.dispose();
    this.tMask.dispose();
    this.quad.geometry.dispose();
    this.edge.dispose();
  }
}
