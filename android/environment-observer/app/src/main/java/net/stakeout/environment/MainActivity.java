package net.stakeout.environment;
import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import android.text.InputType;
import android.widget.*;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

public final class MainActivity extends Activity {
  private EditText image,key;private TextView status;private final Handler handler=new Handler(Looper.getMainLooper());
  private final Runnable refresh=new Runnable(){public void run(){status.setText(BridgeService.display);handler.postDelayed(this,1000);}};
  @Override public void onCreate(Bundle state){super.onCreate(state);
    ScrollView scroll=new ScrollView(this);LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(24,32,24,24);scroll.addView(root);setContentView(scroll);
    TextView title=new TextView(this);title.setText(BuildConfig.LAB_MODE?"Stakeout Environment Lab":"Stakeout Android Observer");title.setTextSize(24);root.addView(title);
    TextView detail=new TextView(this);detail.setText(BuildConfig.LAB_MODE?"Application test state only. This app does not modify Android Wi-Fi, cellular, Bluetooth or mock-location flags.":"Independent Android API readback. Cached sample timestamps and mock-location flags are preserved. Scans run only when requested.");root.addView(detail);
    image=new EditText(this);image.setHint("DuoPlus image ID");image.setSingleLine(true);root.addView(image);
    key=new EditText(this);key.setHint("64-character per-device key (leave blank to keep)");key.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);key.setSingleLine(true);root.addView(key);
    try{JSONObject c=new JSONObject(new String(Files.readAllBytes(new File(getFilesDir(),"environment-config.json").toPath()),StandardCharsets.UTF_8));image.setText(c.getString("imageId"));}catch(Exception ignored){}
    button(root,"Save configuration",()->save());
    if(!BuildConfig.LAB_MODE)button(root,"Grant observation permissions",()->permissions());
    button(root,"Start receiver",()->{if(!BuildConfig.LAB_MODE&&checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){permissions();return;}try{startForegroundService(new Intent(this,BridgeService.class));}catch(RuntimeException e){toast("Unable to start. Check permissions.");}});
    button(root,"Stop receiver",()->{stopService(new Intent(this,BridgeService.class));BridgeService.display="Stopped. Test state cleared; Android radios unchanged.";});
    if(!BuildConfig.LAB_MODE)button(root,"Request Wi-Fi and Bluetooth scans",()->{if(!BridgeService.running){toast("Start the observer first.");return;}startService(new Intent(this,BridgeService.class).setAction(BridgeService.SCAN));});
    status=new TextView(this);status.setTextIsSelectable(true);status.setTextSize(13);root.addView(status);
  }
  private void button(LinearLayout root,String text,Runnable action){Button b=new Button(this);b.setText(text);b.setOnClickListener(v->action.run());root.addView(b);}
  private void toast(String s){Toast.makeText(this,s,Toast.LENGTH_LONG).show();}
  private void save(){try{
    String id=image.getText().toString().trim(),secret=key.getText().toString().trim();if(!id.matches("[A-Za-z0-9_.:-]{1,200}"))throw new IllegalArgumentException();
    if(!secret.isEmpty())Wire.unhex(secret);else if(!new File(getFilesDir(),"control-token").isFile()){toast("A per-device key is required.");return;}
    stopService(new Intent(this,BridgeService.class));
    if(!secret.isEmpty())Files.write(new File(getFilesDir(),"control-token").toPath(),(secret+"\n").getBytes(StandardCharsets.UTF_8));
    Files.write(new File(getFilesDir(),"environment-config.json").toPath(),new JSONObject().put("imageId",id).toString().getBytes(StandardCharsets.UTF_8));key.setText("");toast("Saved. Start the receiver explicitly.");
  }catch(Exception e){toast("Invalid image ID or key; configuration was not saved.");}}
  private void permissions(){List<String> required=new ArrayList<>(Arrays.asList(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.READ_PHONE_STATE));if(Build.VERSION.SDK_INT>=31){required.add(Manifest.permission.BLUETOOTH_SCAN);required.add(Manifest.permission.BLUETOOTH_CONNECT);}if(Build.VERSION.SDK_INT>=33)required.add(Manifest.permission.POST_NOTIFICATIONS);requestPermissions(required.toArray(new String[0]),42);}
  @Override public void onResume(){super.onResume();handler.post(refresh);}
  @Override public void onPause(){handler.removeCallbacksAndMessages(null);super.onPause();}
}
