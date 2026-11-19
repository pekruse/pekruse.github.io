(() => {
  const form=document.getElementById('interview-form');
  if(!form)return;
  const fields=form.elements,button=document.getElementById('zoom-signin'),status=document.getElementById('booking-status');
  let session=null,flow=0,popup=null,expiryTimer=null;
  let busy=false;
  const accountDialog=document.createElement('dialog');
  accountDialog.id='zoom-account-dialog';accountDialog.setAttribute('aria-labelledby','zoom-account-heading');
  const heading=document.createElement('h3'),account=document.createElement('p'),help=document.createElement('p'),actions=document.createElement('div');
  heading.id='zoom-account-heading';heading.textContent='Your Zoom account';
  const continueButton=document.createElement('button'),switchButton=document.createElement('button'),closeButton=document.createElement('button');
  continueButton.type=switchButton.type=closeButton.type='button';
  continueButton.textContent='Continue with Zoom';switchButton.textContent='Use another account';closeButton.textContent='Close';
  help.setAttribute('role','status');
  accountDialog.style.cssText='width:min(26rem,calc(100vw - 2rem));box-sizing:border-box;padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text,inherit);box-shadow:0 20px 70px #0004;';
  actions.style.cssText='display:flex;flex-wrap:wrap;gap:10px;margin-top:20px;';
  for(const control of [continueButton,switchButton,closeButton])control.style.cssText='font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:inherit;cursor:pointer;';
  continueButton.style.background='#0b5cff';continueButton.style.color='#fff';
  actions.append(continueButton,switchButton,closeButton);accountDialog.append(heading,account,help,actions);document.body.append(accountDialog);
  function hideSwitch(){if(accountDialog.open)accountDialog.close();}
  function showSwitch(sameAccount=false){
    account.textContent=session?'Signed in as '+session.email:'Connect your Zoom account to reserve this meeting.';
    help.textContent=sameAccount?'Zoom returned the same account. Choose “Use another account” to change it in Zoom, then continue.':'Your booking will use the email shown here.';
    continueButton.textContent='Continue with Zoom';
    if(!accountDialog.open)accountDialog.showModal();
  }
  const zoomReady=()=>Boolean(!busy&&session&&session.expiresAt>Date.now()+15000&&fields.zoomSession.value&&fields.zoomVerifier.value);
  function render(){
    const zoom=fields.format.value==='Zoom';
    document.getElementById('booking-google-auth').hidden=zoom;
    document.getElementById('booking-zoom-auth').hidden=!zoom;
    fields.token.disabled=zoom;fields.zoomSession.disabled=!zoom;fields.zoomVerifier.disabled=!zoom;
    button.disabled=busy||!window.zoomOAuthAvailable;
    button.textContent=busy?'Connecting to Zoom…':zoomReady()?'Change Zoom account':'Sign in with Zoom';
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
    if(busy)return;
    if(!window.zoomOAuthAvailable)throw Error('Deploy the updated backend before using Zoom sign-in.');
    hideSwitch();
    const previousEmail=zoomReady()?session.email:null;
    const current=++flow;
    if(popup&&!popup.closed)popup.close();
    popup=window.open('about:blank','patrick-zoom-signin','width=560,height=740');
    if(!popup)throw Error('Allow the Zoom sign-in popup, then try again.');
    busy=true;notify();
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
          if(expiryTimer)clearTimeout(expiryTimer);
          session={email:result.email,name:result.name,expiresAt:result.expiresAt};
          fields.zoomSession.value=result.session;fields.zoomVerifier.value=verifier;
          expiryTimer=setTimeout(()=>{clear();notify();},Math.max(0,result.expiresAt-Date.now()-15000));
          busy=false;if(popup&&!popup.closed)popup.close();notify();
          if(previousEmail&&previousEmail.toLowerCase()===result.email.toLowerCase()){
            showSwitch(true);status.textContent='Zoom returned the same account: '+result.email+'. Switch accounts in Zoom, then continue here.';
          }
          return session;
        }
        if(popup.closed)throw Error('Zoom sign-in was closed before it finished. Please try again.');
      }
      if(current===flow)throw Error('Zoom sign-in timed out. Please try again.');
    }catch(error){
      if(current===flow){busy=false;if(popup&&!popup.closed)popup.close();notify();status.textContent=error.message;}
      throw error;
    }
  }
  window.bookingAuth={ready:()=>fields.format.value==='Zoom'?zoomReady():Boolean(fields.token.value),zoomReady,startZoom:start,render};
  button.addEventListener('click',()=>{
    if(zoomReady()){showSwitch();return;}
    start().catch(error=>{status.textContent=error.message;});
  });
  continueButton.addEventListener('click',()=>start().catch(error=>{status.textContent=error.message;}));
  switchButton.addEventListener('click',()=>{
    const portal=window.open('https://zoom.us/profile','patrick-zoom-account','width=600,height=740');
    help.textContent=portal?'In the Zoom window, use your profile menu to switch accounts, or sign out and sign in with another account. Then return here and continue.':'Allow popups to open Zoom, then try again.';
    if(portal){continueButton.textContent='I’ve switched accounts — continue';portal.focus();}
  });
  closeButton.addEventListener('click',()=>hideSwitch());
  accountDialog.addEventListener('click',event=>{if(event.target===accountDialog){const box=accountDialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)hideSwitch();}});
  form.addEventListener('input',render);form.addEventListener('signin',render);
  window.addEventListener('pagehide',()=>{flow++;if(popup&&!popup.closed)popup.close();});
  render();
})();
