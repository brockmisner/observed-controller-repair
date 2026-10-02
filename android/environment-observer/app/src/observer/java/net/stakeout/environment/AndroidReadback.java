package net.stakeout.environment;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.location.*;
import android.net.wifi.*;
import android.os.*;
import android.telephony.*;
import android.bluetooth.*;
import android.bluetooth.le.*;
import org.json.*;
import java.util.*;

/** Reads platform APIs only. No setters, hooks, mock suppression or modeled values. */
@SuppressWarnings("deprecation")
final class AndroidReadback implements AutoCloseable {
  private final Context context;
  private final Handler handler=new Handler(Looper.getMainLooper());
  private final LocationManager locations;
  private final WifiManager wifi;
  private final TelephonyManager telephony;
  private final Map<String,JSONObject> ble=new LinkedHashMap<>();
  private volatile boolean wifiScanCompleted;
  private boolean bleRequested,bleActive,bleComplete;
  private String bleError;
  private BluetoothLeScanner scanner;
  private final LocationListener listener=new LocationListener(){
    public void onLocationChanged(Location l){} public void onProviderEnabled(String p){} public void onProviderDisabled(String p){} public void onStatusChanged(String p,int s,Bundle b){}
  };
  private final BroadcastReceiver wifiReceiver=new BroadcastReceiver(){public void onReceive(Context c,Intent i){
    if(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(i.getAction())&&i.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED,false))wifiScanCompleted=true;
  }};
  private final ScanCallback callback=new ScanCallback(){
    public void onScanResult(int type,android.bluetooth.le.ScanResult result){addBle(result);}
    public void onBatchScanResults(List<android.bluetooth.le.ScanResult> results){for(android.bluetooth.le.ScanResult r:results)addBle(r);}
    public void onScanFailed(int error){synchronized(ble){bleError="SCAN_FAILED";bleActive=false;}}
  };
  AndroidReadback(Context c){
    context=c;locations=c.getSystemService(LocationManager.class);wifi=c.getApplicationContext().getSystemService(WifiManager.class);telephony=c.getSystemService(TelephonyManager.class);
    IntentFilter f=new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
    if(Build.VERSION.SDK_INT>=33)c.registerReceiver(wifiReceiver,f,Context.RECEIVER_NOT_EXPORTED);else c.registerReceiver(wifiReceiver,f);
    handler.post(()->{if(locations!=null&&permitted(Manifest.permission.ACCESS_FINE_LOCATION))for(String p:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER}){
      try{if(locations.getAllProviders().contains(p))locations.requestLocationUpdates(p,1000,0,listener,Looper.getMainLooper());}catch(SecurityException ignored){}catch(RuntimeException ignored){}
    }});
  }
  private boolean permitted(String p){return context.checkSelfPermission(p)==PackageManager.PERMISSION_GRANTED;}
  private static Object nil(Object v){return v==null?JSONObject.NULL:v;}
  private static JSONObject unavailable(String reason)throws JSONException{return new JSONObject().put("availability","UNAVAILABLE").put("reason",reason).put("entries",JSONObject.NULL);}
  private static JSONObject pending(String reason)throws JSONException{return new JSONObject().put("availability","NOT_YET_MEASURED").put("reason",reason).put("entries",JSONObject.NULL);}
  private static Object bounded(long n,long min,long max){return n<min||n>max?JSONObject.NULL:n;}
  private static Object power(int n){return bounded(n,-160,-20);}
  private static boolean validMac(String s){return s!=null&&s.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}")&&!Arrays.asList("00:00:00:00:00:00","02:00:00:00:00:00","ff:ff:ff:ff:ff:ff").contains(s.toLowerCase(Locale.ROOT));}
  private static String limited(String s,int length){return s==null?null:s.substring(0,Math.min(length,s.length()));}
  JSONObject location()throws JSONException{
    JSONArray entries=new JSONArray();String failure=null;
    if(locations==null)failure="NO_LOCATION_SERVICE";
    else if(!permitted(Manifest.permission.ACCESS_FINE_LOCATION))failure="PRECISE_LOCATION_PERMISSION_REQUIRED";
    else if(!locations.isLocationEnabled())failure="LOCATION_TOGGLE_OFF";
    else try{
      for(String p:locations.getAllProviders()){
        if(entries.length()>=16)break;Location l=locations.getLastKnownLocation(p);if(l==null)continue;
        long sampled=l.getElapsedRealtimeNanos()/1000000L;
        if(sampled<0||sampled>SystemClock.elapsedRealtime())continue;
        entries.put(new JSONObject().put("provider",p).put("lat",l.getLatitude()).put("lng",l.getLongitude())
          .put("accuracyM",l.hasAccuracy()?l.getAccuracy():JSONObject.NULL).put("speedMps",l.hasSpeed()?l.getSpeed():JSONObject.NULL)
          .put("bearingDeg",l.hasBearing()?l.getBearing():JSONObject.NULL).put("sampledBootMs",sampled)
          .put("isMock",Build.VERSION.SDK_INT>=31?l.isMock():l.isFromMockProvider()));
      }
    }catch(SecurityException e){failure="PERMISSION_DENIED";}catch(RuntimeException e){failure="LOCATION_READ_FAILED";}
    JSONObject result=new JSONObject();
    if(failure!=null)return result.put("availability","UNAVAILABLE").put("reason",failure).put("samples",JSONObject.NULL);
    if(entries.length()==0)return result.put("availability","NOT_YET_MEASURED").put("reason","NO_LOCATION_FIX").put("samples",JSONObject.NULL);
    return result.put("availability","MEASURED").put("samples",entries);
  }
  private JSONObject connection()throws JSONException{
    String reason=null;WifiInfo info=null;
    try{if(wifi==null)reason="NO_WIFI_SERVICE";else{info=wifi.getConnectionInfo();if(info==null||info.getNetworkId()==-1)reason="NOT_CONNECTED";else if(!validMac(info.getBSSID()))reason="BSSID_REDACTED";}}
    catch(SecurityException e){reason="PERMISSION_DENIED";}catch(RuntimeException e){reason="CONNECTION_READ_FAILED";}
    if(reason!=null)return new JSONObject().put("availability","UNAVAILABLE").put("reason",reason).put("bssid",JSONObject.NULL).put("ssid",JSONObject.NULL).put("rssiDbm",JSONObject.NULL);
    String ssid=info.getSSID();if(ssid!=null&&ssid.startsWith("\"")&&ssid.endsWith("\""))ssid=ssid.substring(1,ssid.length()-1);
    return new JSONObject().put("availability","MEASURED").put("bssid",info.getBSSID().toLowerCase(Locale.ROOT)).put("ssid",nil(limited(ssid,128))).put("rssiDbm",bounded(info.getRssi(),-127,0));
  }
  JSONObject wifi()throws JSONException{
    JSONObject result;
    try{
      if(wifi==null)result=unavailable("NO_WIFI_SERVICE");
      else if(!permitted(Manifest.permission.ACCESS_FINE_LOCATION))result=unavailable("PRECISE_LOCATION_PERMISSION_REQUIRED");
      else if(locations!=null&&!locations.isLocationEnabled())result=unavailable("LOCATION_TOGGLE_OFF");
      else{
        List<android.net.wifi.ScanResult> source=wifi.getScanResults();JSONArray entries=new JSONArray();int unsupported=0;
        for(android.net.wifi.ScanResult s:source){
          if(entries.length()>=256)break;
          if(!validMac(s.BSSID)||s.timestamp<0||s.timestamp/1000>SystemClock.elapsedRealtime()||s.level< -127||s.level>0||s.frequency<=0){unsupported++;continue;}
          entries.put(new JSONObject().put("bssid",s.BSSID.toLowerCase(Locale.ROOT)).put("ssid",limited(s.SSID==null?"":s.SSID,128))
            .put("frequencyMHz",s.frequency).put("rssiDbm",s.level).put("sampledBootMs",s.timestamp/1000));
        }
        if(entries.length()==0&&(!wifiScanCompleted||unsupported>0))result=pending(unsupported>0?"NO_USABLE_SCAN_ENTRIES":"NO_CONFIRMED_SCAN");
        else result=new JSONObject().put("availability","MEASURED").put("entries",entries).put("collectionMethod","PLATFORM_CACHE").put("truncated",source.size()>256).put("unsupportedCount",unsupported);
      }
    }catch(SecurityException e){result=unavailable("PERMISSION_DENIED");}catch(RuntimeException e){result=unavailable("WIFI_READ_FAILED");}
    return result.put("connection",connection());
  }
  JSONObject cells()throws JSONException{
    if(telephony==null||!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY))return unavailable("NO_MODEM");
    if(!permitted(Manifest.permission.ACCESS_FINE_LOCATION)||!permitted(Manifest.permission.READ_PHONE_STATE))return unavailable("PERMISSION_DENIED");
    if(locations!=null&&!locations.isLocationEnabled())return unavailable("LOCATION_TOGGLE_OFF");
    try{
      List<CellInfo> source=telephony.getAllCellInfo();if(source==null||source.isEmpty())return pending("NO_CELL_CACHE");
      JSONArray entries=new JSONArray();int unsupported=0;
      for(CellInfo s:source){
        if(entries.length()>=256)break;
        long time=Build.VERSION.SDK_INT>=30?s.getTimestampMillis():s.getTimeStamp()/1000000L;
        if(time<0||time>SystemClock.elapsedRealtime()){unsupported++;continue;}
        JSONObject entry=new JSONObject().put("sampledBootMs",time).put("registered",s.isRegistered());
        if(s instanceof CellInfoLte){CellInfoLte cell=(CellInfoLte)s;CellIdentityLte id=cell.getCellIdentity();
          entry.put("rat","LTE").put("mcc",nil(id.getMccString())).put("mnc",nil(id.getMncString())).put("areaCode",bounded(id.getTac(),0,65535)).put("cellId",bounded(id.getCi(),0,268435455)).put("pci",bounded(id.getPci(),0,503)).put("rsrpDbm",power(cell.getCellSignalStrength().getRsrp()));
        }else if(s instanceof CellInfoNr){CellInfoNr cell=(CellInfoNr)s;CellIdentityNr id=(CellIdentityNr)cell.getCellIdentity();CellSignalStrengthNr signal=(CellSignalStrengthNr)cell.getCellSignalStrength();
          entry.put("rat","NR").put("mcc",nil(id.getMccString())).put("mnc",nil(id.getMncString())).put("areaCode",bounded(id.getTac(),0,16777215)).put("cellId",bounded(id.getNci(),0,68719476735L)).put("pci",bounded(id.getPci(),0,1007)).put("rsrpDbm",power(signal.getSsRsrp()));
        }else{unsupported++;continue;}
        entries.put(entry);
      }
      if(entries.length()==0)return unavailable("UNSUPPORTED_OR_UNUSABLE_CELL_CACHE");
      return new JSONObject().put("availability","MEASURED").put("entries",entries).put("collectionMethod","PLATFORM_CACHE").put("unsupportedCount",unsupported).put("truncated",source.size()>256);
    }catch(SecurityException e){return unavailable("PERMISSION_DENIED");}catch(RuntimeException e){return unavailable("CELL_READ_FAILED");}
  }
  private void addBle(android.bluetooth.le.ScanResult result){synchronized(ble){
    if(!bleActive)return;
    try{String address=result.getDevice().getAddress();if(!validMac(address)||result.getRssi()< -127||result.getRssi()>0)return;
      if(ble.size()>=256&&!ble.containsKey(address))return;
      String name=result.getScanRecord()==null?null:result.getScanRecord().getDeviceName();
      ble.put(address,new JSONObject().put("address",address.toLowerCase(Locale.ROOT)).put("name",nil(limited(name,256))).put("rssiDbm",result.getRssi()).put("sampledBootMs",result.getTimestampNanos()/1000000L));
    }catch(Exception ignored){}
  }}
  JSONObject bluetooth()throws JSONException{synchronized(ble){
    if(bleError!=null)return unavailable(bleError);
    if(!bleRequested)return pending("SCAN_NOT_REQUESTED");
    if(ble.isEmpty()&&!bleComplete)return pending("SCAN_IN_PROGRESS");
    return new JSONObject().put("availability","MEASURED").put("collectionMethod","SCAN_CALLBACK").put("entries",new JSONArray(ble.values())).put("truncated",ble.size()>=256);
  }}
  /** User-triggered scans only. No scan-throttling changes or fake refresh timestamps. */
  void requestScans(){handler.post(()->{
    try{if(wifi!=null&&permitted(Manifest.permission.ACCESS_FINE_LOCATION))wifi.startScan();}catch(RuntimeException ignored){}
    synchronized(ble){if(bleActive)return;bleRequested=true;bleError=null;bleComplete=false;ble.clear();}
    try{
      if(Build.VERSION.SDK_INT>=31&&(!permitted(Manifest.permission.BLUETOOTH_SCAN)||!permitted(Manifest.permission.BLUETOOTH_CONNECT)))throw new SecurityException();
      BluetoothManager manager=context.getSystemService(BluetoothManager.class);BluetoothAdapter adapter=manager==null?null:manager.getAdapter();
      if(adapter==null||!adapter.isEnabled()){synchronized(ble){bleError=adapter==null?"NO_ADAPTER":"BLUETOOTH_DISABLED";}return;}
      scanner=adapter.getBluetoothLeScanner();if(scanner==null){synchronized(ble){bleError="NO_BLE_SCANNER";}return;}
      synchronized(ble){bleActive=true;}scanner.startScan(callback);handler.postDelayed(this::stopScan,5000);
    }catch(SecurityException e){synchronized(ble){bleError="PERMISSION_DENIED";bleActive=false;}}catch(RuntimeException e){synchronized(ble){bleError="SCAN_FAILED";bleActive=false;}}
  });}
  private void stopScan(){try{if(scanner!=null)scanner.stopScan(callback);}catch(SecurityException ignored){}catch(RuntimeException ignored){}synchronized(ble){bleActive=false;bleComplete=true;}}
  public void close(){handler.removeCallbacksAndMessages(null);stopScan();try{if(locations!=null)locations.removeUpdates(listener);}catch(RuntimeException ignored){}try{context.unregisterReceiver(wifiReceiver);}catch(RuntimeException ignored){}}
}
