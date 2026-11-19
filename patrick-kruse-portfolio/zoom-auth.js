(() => {
  const form=document.getElementById('interview-form');
  if(!form)return;
  const fields=form.elements,button=document.getElementById('zoom-signin'),status=document.getElementById('booking-status');
  let session=null,flow=0,popup=null,expiryTimer=null;
  const switchPanel=document.createElement('div');
  switchPanel.hidden=true;switchPanel.id='zoom-switch-account';switchPanel.setAttribute('role','group');switchPanel.setAttribute('aria-label','Switch Zoom account');
  const switchHelp=document.createElement('p'),portal=document.createElement('a'),continueButton=document.createElement('button'),cancelButton=document.createElement('button');
  switchHelp.textContent='Zoom uses the account signed into this browser. Open Zoom and switch accounts, or sign out and sign in with another account. Then return here and continue.';
  portal.href='https://zoom.us/profile';portal.target='_blank';portal.rel='noopener noreferrer';portal.textContent='Open Zoom account';
  continueButton.type='button';continueButton.textContent='Continue with Zoom';
  cancelButton.type='button';cancelButton.textContent='Cancel';
  switchPanel.style.cssText='margin-top:12px;max-width:38rem;';
  portal.style.cssText='display:inline-block;margin:0 12px 12px 0;';
  continueButton.style.cssText='margin:0 12px 12px 0;';cancelButton.style.cssText='margin-bottom:12px;';
  switchPanel.append(switchHelp,portal,document.createElement('br'),continueButton,cancelButton);
  button.after(switchPanel);
  button.setAttribute('aria-controls',switchPanel.id);button.setAttribute('aria-expanded','false');
  function hideSwitch(){switchPanel.hidden=true;button.setAttribute('aria-expanded','false');}
  function showSwitch(){switchPanel.hidden=false;button.setAttribute('aria-expanded','true');portal.focus();}
  const zoomReady=()=>Boolean(session&&session.expiresAt>Date.now()+15000&&fields.zoomSession.value&&fields.zoomVerifier.value);
  function render(){
    const zoom=fields.format.value==='Zoom';
    document.getElementById('booking-google-auth').hidden=zoom;
    document.getElementById('booking-zoom-auth').hidden=!zoom;
    fields.token.disabled=zoom;fields.zoomSession.disabled=!zoom;fields.zoomVerifier.disabled=!zoom;
    button.disabled=!window.zoomOAuthAvailable;
    button.textContent=zoomReady()?'Switch Zoom account':'Sign in with Zoom';
    document.getElementById('zoom-identity').textContent=zoomReady()?'Signed in as '+session.email:'';
    if(zoom)status.textContent=zoomReady()?'Signed in with Zoom. Review your booking.':window.zoomOAuthAvailable?'Sign in with Zoom to reserve your time.':'Zoom sign-in needs the updated backend deployment.';
    else status.textContent=fields.token.value?'Signed in with Google. Review your booking.':'Sign in with Google to reserve your time.';
  }
  function notify(){render();form.dispatchEvent(new Event('signin'));}
  function clear(){session=null;fields.zoomSession.value='';fields.zoomVerifier.value='';if(expiryTimer)clearTimeout(expiryTimer);}
  async function request(params){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      const r=await fetch(form.action+'?'+new URLSearchParams(params),{cache:'no-store',signal:controller.signal});
      if(!r.ok)throw Error('Zoom sign-in service is unavailable.');
      const value=await r.json();if(value.error)throw Error(value.error);return value;
    }finally{clearTimeout(timer);}
  }
  async function start(){
    if(!window.zoomOAuthAvailable)throw Error('Deploy the updated backend before using Zoom sign-in.');
    hideSwitch();
    const previousEmail=zoomReady()?session.email:null;
    const current=++flow;
    if(popup&&!popup.closed)popup.close();
    popup=window.open('about:blank','patrick-zoom-signin','width=560,height=740');
    if(!popup)throw Error('Allow the Zoom sign-in popup, then try again.');
    clear();notify();
    const verifier=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const challenge=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    try{
      const initial=await request({auth:'zoom-start',challenge});
      if(current!==flow)return;
      if(!/^[a-f0-9]{64}$/.test(initial.state)||typeof initial.authorizeUrl!=='string'||!initial.authorizeUrl.startsWith('https://zoom.us/oauth/authorize?'))throw Error('Invalid Zoom sign-in response.');
      popup.location=initial.authorizeUrl;status.textContent='Complete sign-in in the Zoom window.';
      const until=Date.now()+600000;
      while(current===flow&&Date.now()<until){
        await new Promise(resolve=>setTimeout(resolve,2000));
        if(current!==flow)return;
        const result=await request({auth:'zoom-status',state:initial.state,verifier});
        if(current!==flow)return;
        if(result.status==='error')throw Error(result.error||'Zoom sign-in was canceled.');
        if(result.status==='complete'){
          if(!/^[a-f0-9]{64}$/.test(result.session)||!result.email||!Number.isFinite(result.expiresAt)||result.expiresAt<=Date.now())throw Error('Zoom sign-in expired. Try again.');
          session={email:result.email,name:result.name,expiresAt:result.expiresAt};
          fields.zoomSession.value=result.session;fields.zoomVerifier.value=verifier;
          expiryTimer=setTimeout(()=>{clear();notify();},Math.max(0,result.expiresAt-Date.now()-15000));
          if(popup&&!popup.closed)popup.close();notify();
          if(previousEmail&&previousEmail.toLowerCase()===result.email.toLowerCase()){
            showSwitch();status.textContent='Zoom returned the same account: '+result.email+'. Switch accounts in Zoom, then continue here.';
          }
          return session;
        }
        if(popup.closed)throw Error('Zoom sign-in was closed before it finished. Please try again.');
      }
      if(current===flow)throw Error('Zoom sign-in timed out. Please try again.');
    }catch(error){
      if(current===flow){if(popup&&!popup.closed)popup.close();clear();notify();status.textContent=error.message;}
      throw error;
    }
  }
  window.bookingAuth={ready:()=>fields.format.value==='Zoom'?zoomReady():Boolean(fields.token.value),zoomReady,startZoom:start,render};
  button.addEventListener('click',()=>{
    if(zoomReady()){if(switchPanel.hidden)showSwitch();else hideSwitch();return;}
    start().catch(error=>{status.textContent=error.message;});
  });
  continueButton.addEventListener('click',()=>start().catch(error=>{status.textContent=error.message;}));
  cancelButton.addEventListener('click',()=>{hideSwitch();button.focus();});
  form.addEventListener('input',render);form.addEventListener('signin',render);
  window.addEventListener('pagehide',()=>{flow++;if(popup&&!popup.closed)popup.close();});
  render();
})();
