import * as THREE from './vendor/three.module.js';

const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t*t*(3-2*t); };
export const EFFECT_STATES = ['orbit','radar','progress','thinking-dots','loading','uploading','sending','receiving','notifying','alerting','spawning','powering-down'];

// Original procedural effects for the Muster sculpt. Depth-tested ribbons pass
// behind the real mesh, so an orbit reads as a volume rather than a flat overlay.
export function createCompanionEffects(scene, shell) {
  const group = new THREE.Group(); scene.add(group);
  const palette = ['#ffad32','#59dcff','#b58aff'];
  const material = (color, opacity=1) => new THREE.MeshBasicMaterial({color,transparent:true,opacity,side:THREE.DoubleSide,depthWrite:false,toneMapped:false});
  function add(geometry, mat, parent=group) { const mesh=new THREE.Mesh(geometry,mat);parent.add(mesh);return mesh; }
  const ribbons = Array.from({length:4}, (_,i) => {
    const segments=56, vertices=new Float32Array((segments+1)*6), colors=new Float32Array((segments+1)*6), indices=[];
    const start=new THREE.Color(palette[i%3]),end=new THREE.Color('#fffdf3');
    for(let j=0;j<=segments;j++) {
      const f=j/segments, col=start.clone().lerp(end,f*.22);
      for(let side=0;side<2;side++) {const n=(j*2+side)*3;colors[n]=col.r;colors[n+1]=col.g;colors[n+2]=col.b;}
      if(j<segments){const n=j*2;indices.push(n,n+1,n+2,n+1,n+3,n+2);}
    }
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(vertices,3));geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.setIndex(indices);
    const mat=material('#ffffff');mat.vertexColors=true;
    const mesh=add(geo,mat);mesh.frustumCulled=false;return {mesh,segments};
  });
  const dots=Array.from({length:3},()=>add(new THREE.SphereGeometry(.19,24,16),shell.clone()));
  dots.forEach(dot=>{dot.material.transparent=true;});
  const orbitGuides=Array.from({length:3},(_,i)=>add(new THREE.TorusGeometry(1.64,.008,4,120),material(palette[i],.15)));
  const scanGroup=new THREE.Group();group.add(scanGroup);
  const scanRings=[.6,1.1,1.64].map(radius=>add(new THREE.RingGeometry(radius-.007,radius+.007,96),material('#a4efd5',.22),scanGroup));
  const wedge=add(new THREE.CircleGeometry(1.64,48,0,.72),material('#9aeada',.09),scanGroup);
  const scanNeedle=add(new THREE.BoxGeometry(1.64,.016,.008),material('#ccffe3',.85),wedge);scanNeedle.position.x=.82;
  const progressTrack=add(new THREE.TorusGeometry(1.66,.017,6,120),material('#fff3a7',.16));
  const progressArc=add(new THREE.TorusGeometry(1.66,.037,8,96,Math.PI*1.45),material('#fff1a3',.9));
  const badge=add(new THREE.SphereGeometry(.13,20,16),new THREE.MeshStandardMaterial({color:'#8be5d4',emissive:'#24775e',emissiveIntensity:.4,roughness:.26,transparent:true}));
  const badgeRing=add(new THREE.TorusGeometry(.18,.012,8,48),material('#b4f8de',.6));
  const bang=new THREE.Group();group.add(bang);
  const bangStem=add(new THREE.CapsuleGeometry(.16,.8,8,20),shell.clone(),bang);bangStem.position.y=.25;
  const bangDot=add(new THREE.SphereGeometry(.165,24,16),shell.clone(),bang);bangDot.position.y=-.63;
  const uploads=Array.from({length:9},(_,i)=>add(new THREE.SphereGeometry(.035+i%3*.008,10,8),material(palette[i%3],0)));
  const pops=Array.from({length:8},()=>add(new THREE.SphereGeometry(.045,12,8),shell.clone()));
  pops.forEach(pop=>{pop.material.transparent=true;});
  const v=new THREE.Vector3(),next=new THREE.Vector3(),tangent=new THREE.Vector3(),side=new THREE.Vector3(),view=new THREE.Vector3(0,0,1),rotation=new THREE.Euler();
  function ribbon(index, path, width, opacity) {
    const {mesh,segments}=ribbons[index];mesh.visible=opacity>.005;mesh.material.opacity=clamp(opacity);
    if(!mesh.visible)return;
    const attr=mesh.geometry.attributes.position;
    for(let i=0;i<=segments;i++) {
      const t=i/segments;path(t,v);path(Math.min(1,t+.003),next);
      if(i===segments){path(Math.max(0,t-.003),next);tangent.subVectors(v,next);}else tangent.subVectors(next,v);
      side.crossVectors(tangent,view).normalize();
      const taper=Math.pow(Math.sin(t*Math.PI/2),1.3)*width;
      attr.setXYZ(i*2,v.x-side.x*taper,v.y-side.y*taper,v.z-side.z*taper);
      attr.setXYZ(i*2+1,v.x+side.x*taper,v.y+side.y*taper,v.z+side.z*taper);
    }
    attr.needsUpdate=true;
  }
  function update({active,weights:w,time:t,stateTime,intensity,pose,transferPosition}) {
    const energy=clamp(intensity), g=k=>(w[k]||0)*energy, center=2.15+pose.y;
    const orbit=g('orbit'),radar=g('radar'),progress=g('progress'),loading=g('loading'),upload=g('uploading');
    const orbitAmount=Math.max(orbit,loading,upload*.65);
    ribbons.forEach(r=>{r.mesh.visible=false;});
    for(let i=0;i<3;i++) {
      const guide=orbitGuides[i];guide.visible=orbitAmount>.005;
      guide.position.set(0,center,0);guide.rotation.set(.45+i*.65,.25+i*.45,i*.85);guide.scale.set(1,1.05,1);guide.material.opacity=orbitAmount*.10;
      ribbon(i,(p,out)=>{
        const angle=t*(1.05+i*.23)+i*2.1-(1-p)*2.4;
        out.set(Math.cos(angle)*1.64,Math.sin(angle)*1.74,0);
        rotation.set(.45+i*.65,.25+i*.45,i*.85);out.applyEuler(rotation);out.y+=center;
      },.035+i*.006,orbitAmount*.90);
    }
    scanGroup.visible=radar>.005;scanGroup.position.set(0,center,-.08);scanGroup.rotation.set(.28,-.15,0);
    scanRings.forEach(r=>{r.material.opacity=radar*.25;});wedge.rotation.z=t*1.4;wedge.material.opacity=radar*.12;scanNeedle.material.opacity=radar*.8;
    progressTrack.visible=progressArc.visible=progress>.005;
    for(const arc of [progressTrack,progressArc]){arc.position.set(0,center,0);arc.rotation.set(.25,.25,t*.9);}
    progressTrack.material.opacity=progress*.16;progressArc.material.opacity=progress*.92;
    const dotAmount=g('thinking-dots');
    const split=active==='thinking-dots'?smooth(stateTime/.6):1;
    dots.forEach((dot,i)=>{dot.visible=dotAmount>.005;dot.material.color.copy(shell.color);dot.material.opacity=dotAmount*split;dot.scale.setScalar(.82+.18*Math.sin(t*4-i*.9));dot.position.set((i-1)*.64*split,center+Math.max(0,Math.sin(t*4-i*.9))*.13,0);});
    const transfer=Math.max(g('sending'),g('receiving'));
    const direction=g('sending')>=g('receiving')?'sending':'receiving';
    if(transfer>.005&&transferPosition) for(let i=0;i<3;i++) {
      ribbon(i,(p,out)=>{const current=transferPosition(direction,t,energy),offset=Math.min((1-p)*(.44+i*.11),current.phase*2.25),point=transferPosition(direction,t-offset,energy);out.set(point.x,2.15+point.y-i*.045,-.06-i*.03);},.022+i*.009,transfer*(.75-i*.16)*transferPosition(direction,t,energy).visibility);
    }
    const notify=g('notifying'),pulse=.5+.5*Math.sin(t*4);
    badge.visible=badgeRing.visible=notify>.005;badge.position.set(.88,3.38+pose.y,.45);badge.scale.setScalar(.8+pulse*.22);badge.material.opacity=notify;
    badgeRing.position.copy(badge.position);badgeRing.material.opacity=notify*(1-pulse)*.8;badgeRing.scale.setScalar(1+pulse*.5);
    const alert=(energy>0?(w.alerting||0):0)*(active==='alerting'?smooth(stateTime/.55):1);
    bang.visible=alert>.005;bang.position.set(pose.x,center,0);bang.scale.setScalar(Math.max(.001,alert));bang.rotation.z=pose.tilt;
    bangStem.material.color.copy(shell.color);bangDot.material.color.copy(shell.color);
    uploads.forEach((particle,i)=>{const phase=(t*.65+i/9)%1;particle.visible=upload>.005;particle.material.opacity=upload*Math.sin(phase*Math.PI);particle.position.set((i%3-1)*.42,center-1.8+phase*3.5,.45+Math.sin(i)*.3);});
    const pop=Math.max(g('spawning'),g('powering-down'));const intro=active==='spawning',age=clamp(stateTime/1.25),travel=intro?age:1-age;
    pops.forEach((particle,i)=>{particle.visible=pop>.005&&stateTime<1.25;particle.material.color.copy(shell.color);particle.material.opacity=pop*Math.sin(age*Math.PI);const a=i*Math.PI/4;particle.position.set(Math.cos(a)*travel*1.25,center+Math.sin(a)*travel*1.25,Math.sin(i*2.4)*.3);particle.scale.setScalar(.5+Math.sin(age*Math.PI));});
    group.visible=energy>0;
  }
  return {update,group};
}
