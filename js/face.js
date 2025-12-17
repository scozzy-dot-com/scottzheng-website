import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// --- CONFIG ---
const MODEL_PATH = '../assets/mario_scott_hat.glb'; 
const GRAB_RADIUS = 0.55;       
const STRETCH_LIMIT = 3.5;      
const RETURN_SPEED = 0.25;       
const RELEASE_DELAY = 50;       
const RESET_TIMEOUT = 4000; 

// Animation
const IDLE_SPEED = 0.0025;
const IDLE_AMP = 0.1;
const TRACKING_SPEED = 0.15;

// --- GLOBAL STATE ---
let faceMesh = null; 
let headGroup = new THREE.Group(); 
let eyes = []; 
let originalPositions = null; 

// Interaction
let isDragging = false;
let isRotating = false;
let lastInteractionTime = Date.now();
let dragStartPoint = new THREE.Vector3(); 
let currentDragPoint = new THREE.Vector3(); 
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
let lastMouseUpTime = 0;
let activeIndices = [];
let grabZones = null; 

// Animation State
let targetRotation = { x: 0, y: 0 };
let currentRotation = { x: 0, y: 0 };
let blinkTimer = 0;
let isBlinking = false;
let introProgress = 0; 
let time = 0; 
let mouthIndices = []; 

// Particles
const particles = [];
const particleGeo = new THREE.PlaneGeometry(0.1, 0.1);
const particleMat = new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide, transparent: true });

fetch('../assets/grabzones.json').then(r => r.json()).then(data => { grabZones = data; });

// --- SCENE SETUP ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0, 3.5); 

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace; 
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableRotate = false; 
controls.enableZoom = true;
controls.minDistance = 0.5;
controls.maxDistance = 5.0;

// --- AUDIO ---
const listener = new THREE.AudioListener();
camera.add(listener);
const bgm = new THREE.Audio(listener);
const boingSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
let musicLoaded = false;

audioLoader.load('../assets/bgm.mp3', (b) => { bgm.setBuffer(b); bgm.setLoop(true); bgm.setVolume(0.5); musicLoaded = true; });
audioLoader.load('./boing.mp3', (b) => { boingSound.setBuffer(b); boingSound.setVolume(0.8); });

function toggleMusic() {
    const btn = document.getElementById('start-btn');
    const txt = document.getElementById('mute-btn');
    if (musicLoaded && !bgm.isPlaying) {
        bgm.play();
        if(btn) btn.classList.add('playing');
        txt.innerText = "[ SOUND ON ]";
    } else if (bgm.isPlaying) {
        bgm.pause();
        if(btn) btn.classList.remove('playing');
        txt.innerText = "[ SOUND OFF ]";
    }
}
if(document.getElementById('start-btn')) document.getElementById('start-btn').addEventListener('click', toggleMusic);
document.getElementById('mute-btn').addEventListener('click', toggleMusic);

// --- N64 LIGHTING ---
scene.add(new THREE.AmbientLight(0xffffff, 0.6)); 

const dirLight = new THREE.DirectionalLight(0xffffee, 1.3); 
dirLight.position.set(2, 4, 5); 
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0xddeeff, 0.6);
fillLight.position.set(-3, 0, 4);
scene.add(fillLight);

const backLight = new THREE.DirectionalLight(0xffffff, 1.2); 
backLight.position.set(0, 5, -5);
scene.add(backLight);

// --- LOADER ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

const loader = new GLTFLoader();
loader.load(MODEL_PATH, (gltf) => {
    const skinGeoms = [];
    
    gltf.scene.updateMatrixWorld(true);
    
    gltf.scene.traverse((child) => {
        if (child.isMesh) {
            const matName = child.material.name.toUpperCase();
            
            const geom = child.geometry.clone();
            geom.applyMatrix4(child.matrixWorld);
            if (!geom.attributes.uv) geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 2), 2));

            const baseColor = child.material.map ? new THREE.Color(0xffffff) : child.material.color;
            const plasticMat = new THREE.MeshPhongMaterial({
                map: child.material.map || null,
                color: baseColor,
                specular: 0x444444,
                shininess: 30,
                flatShading: false,
                side: THREE.DoubleSide
            });

            if (matName.includes("BLUE")) {
                // EYE
                const eyeMesh = new THREE.Mesh(geom, plasticMat);
                eyeMesh.geometry.computeBoundingBox();
                const center = eyeMesh.geometry.boundingBox.getCenter(new THREE.Vector3());
                eyeMesh.geometry.translate(-center.x, -center.y, -center.z);
                eyeMesh.position.copy(center); 
                eyeMesh.userData.originalPos = center.clone(); 
                
                headGroup.add(eyeMesh);
                eyes.push(eyeMesh);
            } 
            else if (matName.includes("SKIN")) {
                // SKIN - Save texture to user data for merging
                geom.userData.map = child.material.map;
                skinGeoms.push(geom);
            } 
            else {
                // RIGID
                const mesh = new THREE.Mesh(geom, plasticMat);
                headGroup.add(mesh);
            }
        }
    });

    if (skinGeoms.length > 0) {
        const mergedSkin = BufferGeometryUtils.mergeGeometries(skinGeoms, true);
        
        // Use texture from first skin mesh if available
        const skinMap = skinGeoms[0].userData.map || null;
        const skinMat = new THREE.MeshPhongMaterial({
            color: 0xffdbac, 
            specular: 0x333333,
            shininess: 20,
            map: skinMap // RESTORED TEXTURE
        });
        if(skinMap) skinMat.color.setHex(0xffffff); // White base if texture exists

        faceMesh = new THREE.Mesh(mergedSkin, skinMat); 
        originalPositions = new Float32Array(faceMesh.geometry.attributes.position.array);
        
        // Find mouth vertices
        const pos = faceMesh.geometry.attributes.position;
        for(let i=0; i<pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            const z = pos.getZ(i);
            if (y < -3.0 && y > -6.0 && Math.abs(x) < 3.0 && z > 3.0) {
                mouthIndices.push(i);
            }
        }

        headGroup.add(faceMesh);
    }

    // Center Group
    const box = new THREE.Box3().setFromObject(headGroup);
    const center = box.getCenter(new THREE.Vector3());
    headGroup.position.sub(center); 
    
    // Start Small
    headGroup.scale.set(0.001, 0.001, 0.001);
    
    scene.add(headGroup);

}, undefined, (err) => console.error(err));


// --- PARTICLES ---
function spawnSparkles(pos) {
    for(let i=0; i<12; i++) {
        const p = new THREE.Mesh(particleGeo, particleMat);
        p.position.copy(pos);
        p.position.x += (Math.random() - 0.5) * 0.3;
        p.position.y += (Math.random() - 0.5) * 0.3;
        
        p.userData.vel = new THREE.Vector3(
            (Math.random() - 0.5) * 0.08,
            (Math.random() - 0.5) * 0.08,
            (Math.random() - 0.5) * 0.08
        );
        p.userData.life = 1.0;
        scene.add(p);
        particles.push(p);
    }
}

// --- INTERACTION ---
window.addEventListener('contextmenu', e => e.preventDefault());

function onMouseDown(e) {
    if (e.target.id === 'start-btn' || e.target.id === 'mute-btn') return;
    if (!faceMesh) return;

    lastInteractionTime = Date.now();

    if (e.button === 2) { isRotating = true; return; }

    if (e.button === 0) { 
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(faceMesh);

        if (intersects.length > 0) {
            isDragging = true;
            controls.enabled = false;
            
            const hitPoint = intersects[0].point;
            dragPlane.setFromNormalAndCoplanarPoint(
                camera.getWorldDirection(new THREE.Vector3()), hitPoint
            );
            
            headGroup.worldToLocal(hitPoint.clone());
            dragStartPoint.copy(hitPoint); 
            
            const localHit = intersects[0].point.clone();
            faceMesh.worldToLocal(localHit); 

            activeIndices = [];
            const positions = faceMesh.geometry.attributes.position;
            
            for (let i = 0; i < positions.count; i++) {
                const vx = positions.getX(i);
                const vy = positions.getY(i);
                const vz = positions.getZ(i);
                
                const dist = Math.sqrt((vx - localHit.x)**2 + (vy - localHit.y)**2 + (vz - localHit.z)**2);

                if (dist < GRAB_RADIUS) {
                    activeIndices.push({ index: i, dist: dist });
                }
            }
            raycaster.ray.intersectPlane(dragPlane, dragStartPoint); 
        }
    }
}

function onMouseMove(e) {
    lastInteractionTime = Date.now();
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    if (isRotating) {
        targetRotation.y += e.movementX * 0.005;
        targetRotation.x += e.movementY * 0.005;
        return;
    }

    if (isDragging && faceMesh) {
        raycaster.setFromCamera(mouse, camera);
        if (raycaster.ray.intersectPlane(dragPlane, currentDragPoint)) {
            
            const worldDelta = new THREE.Vector3().subVectors(currentDragPoint, dragStartPoint);
            worldDelta.clampLength(0, STRETCH_LIMIT);
            
            const rotationMatrix = new THREE.Matrix4().extractRotation(headGroup.matrixWorld).invert();
            const localDelta = worldDelta.clone().applyMatrix4(rotationMatrix).divideScalar(0.1); 

            const positions = faceMesh.geometry.attributes.position;
            
            for (let k = 0; k < activeIndices.length; k++) {
                const { index, dist } = activeIndices[k];
                const ox = originalPositions[index * 3];
                const oy = originalPositions[index * 3 + 1];
                const oz = originalPositions[index * 3 + 2];

                const normalizedDist = dist / GRAB_RADIUS;
                let influence = Math.exp(-3.0 * (normalizedDist * normalizedDist));
                if (normalizedDist >= 1.0) influence = 0;

                positions.setXYZ(
                    index,
                    ox + localDelta.x * influence,
                    oy + localDelta.y * influence,
                    oz + localDelta.z * influence
                );
            }
            positions.needsUpdate = true;
        }
    }
}

function onMouseUp() {
    if (isDragging) {
        lastMouseUpTime = Date.now();
        if(boingSound.buffer && musicLoaded && bgm.isPlaying) {
            if(boingSound.isPlaying) boingSound.stop();
            boingSound.setDetune((Math.random() * 200) - 100); 
            boingSound.play();
        }
        
        if(activeIndices.length > 0) {
            const worldSparklePos = dragStartPoint.clone().applyMatrix4(headGroup.matrixWorld);
            spawnSparkles(worldSparklePos);
        }
    }
    isDragging = false;
    isRotating = false;
    activeIndices = []; 
    controls.enabled = true;
}

window.addEventListener('mousedown', onMouseDown);
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);

// --- ANIMATION HELPER ---
const clock = new THREE.Clock();

function updateLife(dt) {
    // 1. Blink
    blinkTimer -= dt;
    if (blinkTimer <= 0) {
        isBlinking = !isBlinking;
        blinkTimer = isBlinking ? 0.15 : (2 + Math.random() * 3);
    }
    const targetY = isBlinking ? 0.1 : 1.0;
    eyes.forEach(eye => {
        eye.scale.y += (targetY - eye.scale.y) * 0.4;
    });

    // 2. Procedural Mouth (Breathing)
    if (!isDragging && faceMesh) {
        const positions = faceMesh.geometry.attributes.position;
        const smileAmt = Math.sin(time * 5) * 0.1;
        let updatedMouth = false;
        for (let i = 0; i < mouthIndices.length; i++) {
            const idx = mouthIndices[i];
            const oy = originalPositions[idx * 3 + 1];
            positions.setY(idx, oy + smileAmt);
            updatedMouth = true;
        }
        if(updatedMouth) positions.needsUpdate = true;
    }

    // 3. Head Tracking
    if (!isDragging && !isRotating) {
        targetRotation.y = mouse.x * 0.5;
        targetRotation.x = -mouse.y * 0.5;
    }

    // 4. Idle Sway
    const idleX = Math.sin(time * IDLE_SPEED * 1000) * IDLE_AMP;
    const idleY = Math.sin(time * IDLE_SPEED * 700) * IDLE_AMP;

    if(introProgress >= 1.0) {
        currentRotation.x += (targetRotation.x - currentRotation.x) * TRACKING_SPEED;
        currentRotation.y += (targetRotation.y - currentRotation.y) * TRACKING_SPEED;
        
        headGroup.rotation.x = currentRotation.x + idleX;
        headGroup.rotation.y = currentRotation.y + idleY;
    }
}

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    time += dt;

    // Intro
    if (introProgress < 1.0) {
        introProgress += dt * 0.8;
        // FAIL-SAFE: If lag happens, clamp to 1 so we don't get stuck
        if(introProgress > 1) introProgress = 1; 
        
        const ease = 1 - Math.pow(1 - introProgress, 3); 
        const s = 0.001 + (0.1 - 0.001) * ease;
        headGroup.scale.set(s, s, s);
        headGroup.rotation.y = (1 - ease) * Math.PI * 2; 
    } else {
        // Ensure scale is correct after intro
        headGroup.scale.set(0.1, 0.1, 0.1);
    }

    updateLife(dt);

    // Particles
    for(let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.position.add(p.userData.vel);
        p.userData.life -= dt * 1.5;
        p.scale.setScalar(p.userData.life);
        if(p.userData.life <= 0) {
            scene.remove(p);
            particles.splice(i,1);
        }
    }

    // Elastic Return
    if (!isDragging && faceMesh && originalPositions) {
        const now = Date.now();
        if (now - lastMouseUpTime > RELEASE_DELAY) {
            const positions = faceMesh.geometry.attributes.position;
            let needsUpdate = false;

            for (let i = 0; i < positions.count; i++) {
                const cx = positions.getX(i);
                const cy = positions.getY(i);
                const cz = positions.getZ(i);
                const ox = originalPositions[i * 3];
                const oy = originalPositions[i * 3 + 1];
                const oz = originalPositions[i * 3 + 2];

                const diffX = ox - cx;
                const diffY = oy - cy;
                const diffZ = oz - cz;

                if (Math.abs(diffX) > 0.001 || Math.abs(diffY) > 0.001 || Math.abs(diffZ) > 0.001) {
                    positions.setXYZ(i, cx + diffX * RETURN_SPEED, cy + diffY * RETURN_SPEED, cz + diffZ * RETURN_SPEED);
                    needsUpdate = true;
                } else if (cx !== ox) {
                    positions.setXYZ(i, ox, oy, oz);
                    needsUpdate = true;
                }
            }
            if (needsUpdate) positions.needsUpdate = true;
        }
    }

    renderer.render(scene, camera);
    controls.update();
}

animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});