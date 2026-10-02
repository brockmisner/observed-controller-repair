package net.stakeout.environment;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.provider.Settings;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** Foreground-only loopback receiver. Lab frames never modify platform APIs. */
public final class BridgeService extends Service {
  public static final String SCAN="net.stakeout.environment.REQUEST_SCANS";
  public static volatile String display="Stopped. No receiver running.";
  public static volatile boolean running;
  private final Handler handler=new Handler(Looper.getMainLooper());
  private final AtomicLong sequence=new AtomicLong();
  private final Set<Socket> sockets=ConcurrentHashMap.newKeySet();
  private ThreadPoolExecutor pool;
  private ServerSocket server;
  private String image,key,boot,instance;
  private int bootCount;
  private LabLease lab;
  private AndroidReadback observer;
  private volatile boolean stopping;
  private final Runnable refresh=new Runnable(){public void run(){
    if(stopping)return;
    try{if(BuildConfig.LAB_MODE&&lab!=null){LabLease.View v=lab.view(SystemClock.elapsedRealtime());display="APPLICATION TEST STATE ONLY\nAndroid radios changed: NO\nImage: "+image+"\nSession: "+v.session+"\nSequence: "+v.sequence+"\nLease remaining: "+Math.max(0,v.expiresAt-SystemClock.elapsedRealtime())+" ms\n\n"+(v.frame==null?"No active test frame.":v.frame);}}
    catch(Exception ignored){}handler.postDelayed(this,500);
  }};
  @Override public void onCreate(){super.onCreate();}
  @Override public int onStartCommand(Intent intent,int flags,int startId){
    if(running){if(intent!=null&&SCAN.equals(intent.getAction())&&observer!=null)observer.requestScans();return START_NOT_STICKY;}
    try{
      JSONObject config=new JSONObject(new String(Files.readAllBytes(new File(getFilesDir(),"environment-config.json").toPath()),StandardCharsets.UTF_8));
      Wire.fields(config,"imageId");image=Wire.string(config,"imageId",200);if(!image.matches("[A-Za-z0-9_.:-]{1,200}"))throw new IllegalArgumentException("INVALID_IMAGE");
      key=new String(Files.readAllBytes(new File(getFilesDir(),"control-token").toPath()),StandardCharsets.UTF_8).trim();Wire.unhex(key);
      bootCount=Settings.Global.getInt(getContentResolver(),Settings.Global.BOOT_COUNT,-1);if(bootCount<0)throw new IllegalArgumentException("BOOT_COUNT_UNAVAILABLE");
      boot=UUID.nameUUIDFromBytes((image+":"+bootCount).getBytes(StandardCharsets.UTF_8)).toString();instance=UUID.randomUUID().toString();
      NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel("environment","Environment testing",NotificationManager.IMPORTANCE_LOW));
      PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
      Notification notification=new Notification.Builder(this,"environment").setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setContentTitle(BuildConfig.LAB_MODE?"Environment lab is running":"Android observer is running")
        .setContentText(BuildConfig.LAB_MODE?"Synthetic app state only; no radio injection":"Reading Android APIs; mock status preserved")
        .setContentIntent(open).setOngoing(true).build();
      int type=BuildConfig.LAB_MODE?(Build.VERSION.SDK_INT>=34?ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE:0):ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
      startForeground(9301,notification,type);
      if(BuildConfig.LAB_MODE){
        android.content.SharedPreferences prefs=getSharedPreferences("epochs",MODE_PRIVATE);
        lab=new LabLease(prefs.getLong("highest:"+image,0),epoch->{if(!prefs.edit().putLong("highest:"+image,epoch).commit())throw new IllegalStateException("EPOCH_PERSIST_FAILED");});
      }else observer=new AndroidReadback(this);
      server=new ServerSocket();server.setReuseAddress(true);server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),BuildConfig.LAB_MODE?9996:9997),4);
      pool=new ThreadPoolExecutor(2,2,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(2));
      stopping=false;running=true;display="Ready on loopback. Image: "+image+"\n"+(BuildConfig.LAB_MODE?"Synthetic test state only.":"Awaiting a signed observation request.");
      new Thread(this::accept,"environment-listener").start();handler.post(refresh);
    }catch(Exception e){display="Start failed: "+safeCode(e,"START_FAILED")+". Check image ID, credentials, permissions and port availability.";stopSelf();}
    return START_NOT_STICKY;
  }
  private void accept(){while(!stopping){
    try{Socket socket=server.accept();socket.setSoTimeout(4000);sockets.add(socket);try{pool.execute(()->serve(socket));}catch(RejectedExecutionException e){sockets.remove(socket);socket.close();}}
    catch(IOException e){if(!stopping){display="Receiver stopped: SOCKET_FAILED";handler.post(this::stopSelf);}break;}
  }}
  private JSONObject base(String requestId)throws JSONException{return new JSONObject().put("protocol",Wire.PROTOCOL).put("version",1).put("imageId",image).put("bootId",boot).put("instanceId",instance).put("requestId",requestId);}
  private void serve(Socket socket){
    try(Socket close=socket){
      String nonce=Wire.nonce();
      Wire.write(socket.getOutputStream(),new JSONObject().put("protocol",Wire.PROTOCOL).put("version",1).put("type","challenge").put("imageId",image).put("bootId",boot).put("instanceId",instance).put("role",BuildConfig.LAB_MODE?"lab":"observer").put("nonce",nonce));
      JSONObject request=Wire.authenticate(Wire.read(socket.getInputStream()),key,nonce);
      String requestId=Wire.string(request,"requestId",32);if(!requestId.matches("[a-f0-9]{32}"))throw new SecurityException("INVALID_REQUEST_ID");
      JSONObject response;
      try{
        if(!image.equals(request.optString("imageId"))||!boot.equals(request.optString("bootId"))||!instance.equals(request.optString("instanceId")))throw new IllegalArgumentException("IDENTITY_MISMATCH");
        response=BuildConfig.LAB_MODE?labRequest(request,requestId):observe(request,requestId);
      }catch(Exception e){response=base(requestId).put("type","error").put("status","ERROR").put("code",safeCode(e,"INVALID_REQUEST"));}
      Wire.write(socket.getOutputStream(),Wire.signed(response,key,nonce));
    }catch(Exception ignored){/* Authentication failures receive no unsigned diagnostic or secret material. */}
    finally{sockets.remove(socket);}
  }
  private JSONObject observe(JSONObject request,String id)throws Exception{
    Wire.fields(request,"op","requestId","imageId","bootId","instanceId");if(!"observe".equals(request.getString("op")))throw new IllegalArgumentException("UNSUPPORTED_OPERATION");
    JSONObject location=observer.location(),wifi=observer.wifi(),cells=observer.cells(),bluetooth=observer.bluetooth();
    JSONObject report=base(id).put("type","observation").put("sequence",sequence.incrementAndGet()).put("phoneBootMs",SystemClock.elapsedRealtime()).put("wallMs",System.currentTimeMillis())
      .put("bootCount",bootCount).put("packageName",getPackageName()).put("evidenceClass","ANDROID_API_READBACK")
      .put("location",location).put("wifi",wifi).put("cells",cells).put("bluetooth",bluetooth);
    display=report.toString(2);return report;
  }
  private JSONObject labRequest(JSONObject request,String id)throws Exception{
    String op=Wire.string(request,"op",20),status;
    if("state".equals(op)){Wire.fields(request,"op","requestId","imageId","bootId","instanceId");status="STATE";}
    else if("open".equals(op)||"close".equals(op)){
      Wire.fields(request,"op","requestId","imageId","bootId","instanceId","sessionId","epoch");
      String session=Wire.string(request,"sessionId",36);long epoch=Wire.integer(request,"epoch",1,9007199254740991L);
      if("open".equals(op)){lab.open(session,epoch,SystemClock.elapsedRealtime());status="OPENED";}else{lab.close(session,epoch,SystemClock.elapsedRealtime());status="CLOSED";}
    }else if("stage".equals(op)){
      Wire.fields(request,"op","requestId","imageId","bootId","instanceId","sessionId","epoch","sequence","leaseMs","frame");
      String session=Wire.string(request,"sessionId",36);long epoch=Wire.integer(request,"epoch",1,9007199254740991L),seq=Wire.integer(request,"sequence",0,9007199254740991L),leaseMs=Wire.integer(request,"leaseMs",100,10000);
      JSONObject frame=request.getJSONObject("frame");
      if(!Boolean.TRUE.equals(frame.get("synthetic"))||!image.equals(frame.getString("imageId"))||!session.equals(frame.getString("sessionId"))||Wire.integer(frame,"sequence",0,9007199254740991L)!=seq)throw new IllegalArgumentException("FRAME_IDENTITY_MISMATCH");
      frame.getJSONArray("wifi");frame.getJSONArray("cells");String bt=frame.getString("bluetoothAction");
      if("HOLD".equals(bt)){if(!frame.has("bluetooth")||!frame.isNull("bluetooth"))throw new IllegalArgumentException("INVALID_BLUETOOTH_HOLD");}
      else if("REPLACE".equals(bt))frame.getJSONArray("bluetooth");else throw new IllegalArgumentException("INVALID_BLUETOOTH_ACTION");
      lab.stage(session,epoch,seq,Wire.integer(frame,"elapsedMs",0,9007199254740991L),frame.toString(),leaseMs,SystemClock.elapsedRealtime());status="STAGED_TEST_STATE";
    }else throw new IllegalArgumentException("UNSUPPORTED_OPERATION");
    LabLease.View view=lab.view(SystemClock.elapsedRealtime());
    return base(id).put("type","lab.result").put("status",status).put("applied",false).put("evidenceClass","APPLICATION_TEST_STATE")
      .put("sessionId",view.session==null?JSONObject.NULL:view.session).put("epoch",view.epoch).put("sequence",view.sequence)
      .put("expiresAtBootMs",view.expiresAt).put("phoneBootMs",SystemClock.elapsedRealtime())
      .put("frame",view.frame==null?JSONObject.NULL:new JSONObject(view.frame));
  }
  private static String safeCode(Exception e,String fallback){String s=e.getMessage();return s!=null&&s.matches("[A-Z_]{1,80}")?s:fallback;}
  @Override public IBinder onBind(Intent intent){return null;}
  @Override public void onDestroy(){
    stopping=true;running=false;handler.removeCallbacksAndMessages(null);
    try{if(server!=null)server.close();}catch(IOException ignored){}
    for(Socket s:sockets)try{s.close();}catch(IOException ignored){}sockets.clear();if(pool!=null)pool.shutdownNow();
    if(observer!=null)observer.close();lab=null;key=null;stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();
  }
}
