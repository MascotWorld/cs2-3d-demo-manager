import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

const cache = new Map();

export function operatorPortraits(templates) {
  const missing = templates.filter(([key, model]) => model && !cache.has(key));
  if (!missing.length) return cache;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(128, 128, false);
    renderer.setClearColor(0, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe2edff, 0x8e7969, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffe6c8, 2.6);
    keyLight.position.set(2, 3, 4);
    scene.add(keyLight);
    const camera = new THREE.OrthographicCamera(-0.37, 0.37, 0.37, -0.37, 0.01, 10);

    for (const [key, template] of missing) {
      const operator = clone(template);
      operator.traverse((obj) => {
        if (obj.isMesh && /first.?person|viewmodel|defusekit/i.test(obj.name)) obj.visible = false;
      });
      scene.add(operator);
      operator.updateMatrixWorld(true);
      const head = operator.getObjectByName('head_0');
      const focus = head?.getWorldPosition(new THREE.Vector3()) ??
        new THREE.Box3().setFromObject(operator).getCenter(new THREE.Vector3());
      focus.y -= 0.16;
      camera.position.copy(focus).add(new THREE.Vector3(0.48, 0.1, 2.1));
      camera.lookAt(focus);
      renderer.render(scene, camera);
      cache.set(key, renderer.domElement.toDataURL('image/png'));
      scene.remove(operator);
    }
  } catch (error) {
    console.warn('Operator portrait render unavailable:', error);
  } finally {
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
  return cache;
}
